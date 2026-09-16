import { describe, expect, it } from "vitest";
import {
  PAID_AUTO_MODELS,
  PaidAutoOpenRouterAdapter,
  PaidAutoExecutionError,
  PaidAutoService,
  classifyPaidAutoFailure,
  type PaidAutoRouteId,
} from "../src/index.js";
import { ProviderError, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";

const credentials = {
  get: (id: string) => id === "DASHSCOPE_API_KEY" ? "dashscope-test" : "test-key",
  set: () => undefined,
  delete: () => true,
  has: () => true,
};

function qualifiedRoutes(): Partial<Record<PaidAutoRouteId, { state: "READY"; commercialEligibility: "verified"; privacy: "verified"; capabilityParity: "verified"; certification: "CERTIFIED" }>> {
  return Object.fromEntries(PAID_AUTO_MODELS.flatMap((model) => [model.direct, model.fallback]).map((route) => [route.routeId, {
    state: "READY",
    commercialEligibility: "verified",
    privacy: "verified",
    capabilityParity: "verified",
    certification: "CERTIFIED",
  }])) as Partial<Record<PaidAutoRouteId, { state: "READY"; commercialEligibility: "verified"; privacy: "verified"; capabilityParity: "verified"; certification: "CERTIFIED" }>>;
}

function fakeAdapter(providerId: ProviderAdapter["providerId"], stream: (req: ChatRequest) => AsyncIterable<StreamEvent>, chat?: (req: ChatRequest) => Promise<never>): ProviderAdapter {
  return {
    providerId,
    async listModels() { return []; },
    async chat(req) {
      if (chat) return chat(req);
      return { id: "test-response", model: req.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }] };
    },
    streamChat: stream,
    async healthCheck() { return { status: "available" as const }; },
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Paid Auto R1", () => {
  it("freezes exactly four canonical models and exact direct/OpenRouter mappings", async () => {
    expect(PAID_AUTO_MODELS.map((model) => model.canonicalModelId)).toEqual([
      "gpt-5.6-luna",
      "glm-5.3-flash",
      "qwen3.8-flash",
      "deepseek-v4.1-flash",
    ]);
    expect(PAID_AUTO_MODELS.map((model) => [model.direct.providerId, model.direct.providerModelId, model.fallback.providerModelId])).toEqual([
      ["openai", "gpt-5.6-luna", "openai/gpt-5.6-luna"],
      ["zai", "glm-5.3-flash", "z-ai/glm-5.3-flash"],
      ["alibaba", "qwen3.8-flash", "qwen/qwen3.8-flash"],
      ["deepseek", "deepseek-flash", "deepseek/deepseek-v4.1-flash"],
    ]);
    expect(PAID_AUTO_MODELS.flatMap((model) => [model.direct.providerModelId, model.fallback.providerModelId])).not.toContain("openrouter/auto");

    const openRouter = new PaidAutoOpenRouterAdapter(fakeAdapter("openrouter", async function* () {}));
    expect(openRouter.canRoute("gpt-5.6-luna")).toBe(true);
    expect(openRouter.canRoute("openrouter/auto")).toBe(false);
    expect(() => openRouter.chat({ model: "claude-anything", messages: [{ role: "user", content: "x" }] })).toThrow("Paid Auto accepts only one of the four registered canonical model IDs.");
  });

  it("has a hard no-network default", async () => {
    let calls = 0;
    const adapter = fakeAdapter("openai", async function* () { calls++; yield { type: "finish", finishReason: "stop" }; });
    const service = new PaidAutoService({ credentialStore: credentials, adapters: { openai: adapter } });
    await expect(service.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "secret prompt" }] })).rejects.toMatchObject({ code: "PAID_AUTO_DISABLED" });
    expect(calls).toBe(0);
    expect(service.asProviderAdapter().canRoute("gpt-5.6-luna")).toBe(false);
  });

  it("uses direct first and falls back only to the same canonical model", async () => {
    const directRequests: ChatRequest[] = [];
    const fallbackRequests: ChatRequest[] = [];
    const direct = fakeAdapter("openai", (req) => (async function* () {
      directRequests.push(req);
      throw new ProviderError("connection refused", "CONNECTION_FAILED", true);
    })());
    const fallback = fakeAdapter("openrouter", (req) => (async function* () {
      fallbackRequests.push(req);
      yield { type: "text_delta", delta: "fallback" };
      yield { type: "finish", finishReason: "stop" };
    })());
    const service = new PaidAutoService({
      credentialStore: credentials,
      adapters: { openai: direct, openrouter: fallback },
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: qualifiedRoutes(),
    });

    const events = await collect(service.streamChat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "secret prompt" }], fallbackModels: ["qwen/qwen3.8-flash"] }));
    expect(events.some((event) => event.type === "text_delta" && event.delta === "fallback")).toBe(true);
    expect(directRequests[0]?.model).toBe("gpt-5.6-luna");
    expect(fallbackRequests[0]?.model).toBe("openai/gpt-5.6-luna");
    expect(fallbackRequests[0]?.fallbackModels).toBeUndefined();
    expect(service.attempts().map((attempt) => attempt.providerModelId)).toEqual(["gpt-5.6-luna", "openai/gpt-5.6-luna"]);
    expect(JSON.stringify(service.attempts())).not.toContain("secret prompt");
  });

  it.each(PAID_AUTO_MODELS)("falls back from $canonicalModelId only to its matching OpenRouter slug", async (model) => {
    const directRequests: ChatRequest[] = [];
    const fallbackRequests: ChatRequest[] = [];
    const direct = fakeAdapter(model.direct.providerId, (req) => (async function* () {
      directRequests.push(req);
      throw new ProviderError("provider outage", "PROVIDER_ERROR", true, { status: 503 });
    })());
    const fallback = fakeAdapter("openrouter", (req) => (async function* () {
      fallbackRequests.push(req);
      yield { type: "text_delta", delta: "same-model fallback" };
      yield { type: "finish", finishReason: "stop" };
    })());
    const adapters: Partial<Record<"openai" | "zai" | "alibaba" | "deepseek" | "openrouter", ProviderAdapter>> = { openrouter: fallback };
    adapters[model.direct.providerId] = direct;
    const service = new PaidAutoService({
      credentialStore: credentials,
      adapters,
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: qualifiedRoutes(),
    });

    const events = await collect(service.streamChat({ model: model.canonicalModelId, messages: [{ role: "user", content: "x" }] }));
    expect(events.some((event) => event.type === "text_delta" && event.delta === "same-model fallback")).toBe(true);
    expect(directRequests[0]?.model).toBe(model.direct.providerModelId);
    expect(fallbackRequests[0]?.model).toBe(model.fallback.providerModelId);
  });

  it("treats a finish-only stream as empty without leaking a false completion", async () => {
    const directEvents: StreamEvent[] = [];
    const fallbackEvents: StreamEvent[] = [];
    const service = new PaidAutoService({
      credentialStore: credentials,
      adapters: {
        openai: fakeAdapter("openai", async function* () {
          directEvents.push({ type: "finish", finishReason: "stop" });
          yield { type: "finish", finishReason: "stop" };
        }),
        openrouter: fakeAdapter("openrouter", async function* () {
          fallbackEvents.push({ type: "text_delta", delta: "fallback" });
          yield { type: "text_delta", delta: "fallback" };
          yield { type: "finish", finishReason: "stop" };
        }),
      },
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: qualifiedRoutes(),
    });

    const events = await collect(service.streamChat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "x" }] }));
    expect(directEvents).toHaveLength(1);
    expect(fallbackEvents).toHaveLength(1);
    expect(events).toEqual([
      { type: "text_delta", delta: "fallback" },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("does not fall back for authorization failures or partial streams", async () => {
    let fallbackCalls = 0;
    const fallback = fakeAdapter("openrouter", async function* () { fallbackCalls++; yield { type: "finish", finishReason: "stop" }; });
    const authService = new PaidAutoService({
      credentialStore: credentials,
      adapters: {
        openai: fakeAdapter("openai", async function* () { throw new ProviderError("unauthorized", "AUTH_ERROR"); }, async () => { throw new ProviderError("unauthorized", "AUTH_ERROR"); }),
        openrouter: fallback,
      },
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: qualifiedRoutes(),
    });
    await expect(authService.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ failureClass: "auth_failure" });
    expect(fallbackCalls).toBe(0);

    let partialFallbackCalls = 0;
    const partialService = new PaidAutoService({
      credentialStore: credentials,
      adapters: {
        openai: fakeAdapter("openai", async function* () {
          yield { type: "text_delta", delta: "partial" };
          throw new ProviderError("stream broke", "STREAM_FAILED", true);
        }),
        openrouter: fakeAdapter("openrouter", async function* () { partialFallbackCalls++; yield { type: "finish", finishReason: "stop" }; }),
      },
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: qualifiedRoutes(),
    });
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of partialService.streamChat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "x" }] })) events.push(event);
    })()).rejects.toMatchObject({ failureClass: "connection_failure", executionCertainty: "partial_output" });
    expect(events).toHaveLength(1);
    expect(partialFallbackCalls).toBe(0);
  });

  it("keeps OpenRouter disabled independently of the global paid gate", async () => {
    let fallbackCalls = 0;
    const service = new PaidAutoService({
      credentialStore: credentials,
      adapters: {
        openai: fakeAdapter("openai", async function* () { throw new ProviderError("busy", "RATE_LIMITED", true); }, async () => { throw new ProviderError("busy", "RATE_LIMITED", true); }),
        openrouter: fakeAdapter("openrouter", async function* () { fallbackCalls++; yield { type: "text_delta", delta: "must not run" }; yield { type: "finish", finishReason: "stop" }; }),
      },
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: false,
      routeQualifications: qualifiedRoutes(),
    });

    await expect(service.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fallbackCalls).toBe(0);
  });

  it("does not retry a timeout with unknown execution state", async () => {
    let fallbackCalls = 0;
    const service = new PaidAutoService({
      credentialStore: credentials,
      adapters: {
        openai: fakeAdapter("openai", async function* () { throw new ProviderError("timeout", "TIMEOUT", true); }, async () => { throw new ProviderError("timeout", "TIMEOUT", true); }),
        openrouter: fakeAdapter("openrouter", async function* () { fallbackCalls++; yield { type: "text_delta", delta: "must not run" }; yield { type: "finish", finishReason: "stop" }; }),
      },
      paidExecutionEnabled: true,
      openRouterFallbackEnabled: true,
      routeQualifications: qualifiedRoutes(),
    });

    await expect(service.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ failureClass: "ambiguous_execution" });
    expect(fallbackCalls).toBe(0);
  });

  it("classifies only the documented fallback failure classes as fallback-eligible", () => {
    expect(classifyPaidAutoFailure(new ProviderError("busy", "RATE_LIMITED", true))).toBe("capacity");
    expect(classifyPaidAutoFailure(new ProviderError("down", "PROVIDER_ERROR", true, { status: 503 }))).toBe("provider_outage");
    expect(classifyPaidAutoFailure(new ProviderError("timeout", "TIMEOUT", true))).toBe("ambiguous_execution");
    expect(classifyPaidAutoFailure(new ProviderError("bad request", "INVALID_REQUEST"))).toBe("invalid_request");
    expect(classifyPaidAutoFailure(new PaidAutoExecutionError({ code: "PARTIAL_STREAM", message: "partial", failureClass: "partial_stream", executionCertainty: "partial_output" }))).toBe("partial_stream");
  });
});
