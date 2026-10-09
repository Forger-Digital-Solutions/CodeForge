import { describe, expect, it } from "vitest";
import { ProviderCapacityGovernor, GovernedProviderAdapter } from "../src/capacity-governor.js";
import { createKiloFreeDirectAdapter } from "../src/provider-factory.js";
import type { ProviderResponseObservation, StreamEvent } from "../src/index.js";

const model = "lab/coder:free";
const request = { model, messages: [{ role: "user" as const, content: "public fixture" }], maxTokens: 16 };
const upstream = { error: { code: 429, message: "Provider returned error", metadata: { provider_name: "Upstream", limit_source: "provider", raw: "Rate limit exceeded" } } };

describe("R71 Kilo model discovery and failure attribution", () => {
  it("preserves canonical free IDs and requires catalog evidence of tools", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => Response.json({ data: [
      { id: model, context_length: 128000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "response_format"] },
      { id: "lab/text:free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
      { id: "lab/unknown:free", pricing: { prompt: "0", completion: "0" } },
      { id: "lab/paid:free", pricing: { prompt: "0", completion: "1" }, supported_parameters: ["tools"] },
    ] }) });
    const models = await adapter.listModels();
    expect(models.map(item => item.modelId)).toEqual([model, "lab/text:free", "lab/unknown:free"]);
    expect(models[0]?.capabilities).toMatchObject({ toolCalling: true, structuredOutput: true, longContext: true });
    expect(models.slice(1).every(item => !item.capabilities.toolCalling)).toBe(true);
  });

  it("attributes one HTTP response once and keeps a gateway upstream wall model-scoped", async () => {
    const observations: ProviderResponseObservation[] = [];
    const governor = new ProviderCapacityGovernor();
    const domain = governor.forQuotaDomain("kilo-free-direct", "kilo-free-direct:SOURCE_IP:fixture");
    const adapter = new GovernedProviderAdapter(createKiloFreeDirectAdapter({
      fetchFn: async () => Response.json(upstream, { status: 429, headers: { "retry-after": "120" } }),
      onResponse: observation => observations.push(observation),
    }), domain);
    await expect(adapter.chat(request)).rejects.toMatchObject({ status: 429, rateLimitScope: "model" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ modelId: model, rateLimitScope: "model" });
    expect(domain.isCoolingDown("kilo-free-direct", model)).toBe(true);
    expect(domain.isCoolingDown("kilo-free-direct", "lab/sibling:free")).toBe(false);
    expect(governor.isCoolingDown("kilo-free-direct", model)).toBe(false);
  });

  it.each(["http429", "http200", "sse"])("keeps the exact model's upstream allocation wall scoped to its route (%s)", async (transport) => {
    const error = { error: { code: 429, message: "Provider returned error", metadata: { raw: `${model} is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your own allowance.` } } };
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => transport === "sse" ? new Response(`data: ${JSON.stringify(error)}\n\n`) : Response.json(error, { status: transport === "http429" ? 429 : 200 }) });
    if (transport === "sse") {
      const events: StreamEvent[] = [];
      for await (const event of adapter.streamChat(request)) events.push(event);
      expect(events).toEqual([expect.objectContaining({ type: "error", status: 429, rateLimitScope: "model" })]);
    } else {
      await expect(adapter.chat(request)).rejects.toMatchObject({ status: 429, rateLimitScope: "model" });
    }
  });

  it.each([
    { error: { code: 429, message: "Rate limit exceeded for free models. Please try again later." } },
    { error: { ...upstream.error, message: "free-models-per-day limit exceeded for this account" } },
    { error: { ...upstream.error, message: "Model TPM rate limit reached per IP" } },
    { error: { code: 429, message: "Unknown rate limit", metadata: { provider_name: "Upstream" } } },
    { error: { code: 429, message: "Provider returned error", metadata: { raw: "lab/another:free is temporarily rate-limited upstream." } } },
    { error: { code: 429, message: "Provider returned error", metadata: { raw: "Unknown upstream rate limit" } } },
    { error: { code: 429, message: "Free models per IP quota exceeded", metadata: { raw: `${model} is temporarily rate-limited upstream.` } } },
    { error: { code: 429, message: "Provider returned error", metadata: { raw: `${model} is temporarily rate-limited upstream. Free models per IP quota exceeded.` } } },
  ])("retains whole-domain cooldown for gateway or ambiguous quota walls %#", async body => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => Response.json(body, { status: 429 }) });
    await expect(adapter.chat(request)).rejects.toMatchObject({ status: 429, rateLimitScope: "provider" });
  });

  it("preserves upstream scope on an in-band SSE error", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => new Response(`data: ${JSON.stringify(upstream)}\n\n`) });
    const events: StreamEvent[] = [];
    for await (const event of adapter.streamChat(request)) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: "error", status: 429, rateLimitScope: "model" })]);
  });

  it("rejects an embedded non-stream error after HTTP 200 and observes its actual limit once", async () => {
    const observations: ProviderResponseObservation[] = [];
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => Response.json(upstream), onResponse: observation => observations.push(observation) });
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429, rateLimitScope: "model" });
    expect(observations).toEqual([expect.objectContaining({ status: 429, rateLimitScope: "model" })]);
  });

  it("rejects a non-stream response without assistant choices", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => Response.json({}) });
    await expect(adapter.chat(request)).rejects.toMatchObject({ code: "EMPTY_RESPONSE" });
  });

  it("reports an internal stream timeout instead of returning an empty successful stream", async () => {
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => { throw new DOMException("timed out", "AbortError"); } });
    await expect(async () => { for await (const _event of adapter.streamChat(request)) { /* Drain transport. */ } }).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("respects an explicit caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createKiloFreeDirectAdapter({ fetchFn: async () => { throw new DOMException("cancelled", "AbortError"); } });
    const events: StreamEvent[] = [];
    for await (const event of adapter.streamChat(request, controller.signal)) events.push(event);
    expect(events).toEqual([]);
  });
});
