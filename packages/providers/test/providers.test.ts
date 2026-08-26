import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockProvider,
  InMemoryProviderCatalog,
  ProviderError,
  ScriptedTestProvider,
  TestProviderIsolationError,
} from "../src/index.js";
import type { ChatRequest, StreamEvent } from "../src/index.js";

describe("MockProvider", () => {
  it("should create a provider with string id", () => {
    const provider = createMockProvider("test-provider");
    expect(provider.providerId).toBe("test-provider");
    expect(provider.isTestProvider).toBe(true);
  });

  it("should create a provider with options object", () => {
    const provider = createMockProvider({
      providerId: "custom-provider",
      models: [
        {
          modelId: "custom-model",
          displayName: "Custom Model",
          capabilities: {
            text: true,
            coding: true,
            toolCalling: false,
            vision: false,
            structuredOutput: false,
            longContext: false,
          },
          isFree: true,
          freeStatus: "verified_free",
        },
      ],
    });
    expect(provider.providerId).toBe("custom-provider");
    expect(provider.isTestProvider).toBe(true);
  });

  it("should list models", async () => {
    const provider = createMockProvider("test");
    const models = await provider.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.modelId).toBe("mock-model");
  });

  it("should return mock response for chat", async () => {
    const provider = createMockProvider("test");
    const request: ChatRequest = {
      model: "mock-model",
      messages: [{ role: "user", content: "Hello" }],
    };
    const response = await provider.chat(request);
    expect(response.id).toBeDefined();
    expect(response.model).toBe("mock-model");
    expect(response.choices[0]?.message.role).toBe("assistant");
  });

  it("should return configured responses", async () => {
    const provider = createMockProvider({
      providerId: "test",
      responses: [
        {
          id: "resp-1",
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Custom response" },
              finishReason: "stop",
            },
          ],
        },
      ],
    });

    const request: ChatRequest = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
    };
    const response = await provider.chat(request);
    expect(response.choices[0]?.message.content).toBe("Custom response");
  });

  it("should stream events", async () => {
    const provider = createMockProvider("test");
    const events: StreamEvent[] = [];
    const request: ChatRequest = {
      model: "mock-model",
      messages: [{ role: "user", content: "Hello" }],
    };

    for await (const event of provider.streamChat(request)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });

  it("should stream configured events", async () => {
    const provider = createMockProvider({
      providerId: "test",
      streamEvents: [
        [
          { type: "text_delta", delta: "Hello" },
          { type: "text_delta", delta: " world" },
          { type: "usage", usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } },
          { type: "finish", finishReason: "stop" },
        ],
      ],
    });

    const request: ChatRequest = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
    };

    const events: StreamEvent[] = [];
    for await (const event of provider.streamChat(request)) {
      events.push(event);
    }

    expect(events).toHaveLength(4);
    expect((events[0] as { delta: string }).delta).toBe("Hello");
    expect((events[1] as { delta: string }).delta).toBe(" world");
    expect(events[2]?.type).toBe("usage");
    expect(events[3]?.type).toBe("finish");
  });

  it("should health check", async () => {
    const provider = createMockProvider("test");
    const health = await provider.healthCheck();
    expect(health.status).toBe("available");
    expect(health.latencyMs).toBe(1);
  });
});

describe("InMemoryProviderCatalog", () => {
  let catalog: InMemoryProviderCatalog;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    catalog = new InMemoryProviderCatalog();
  });

  it("should register and retrieve providers", () => {
    const provider = createMockProvider("test");
    catalog.register(provider);

    const retrieved = catalog.get("test");
    expect(retrieved).toBe(provider);
  });

  it("should return undefined for missing providers", () => {
    const retrieved = catalog.get("nonexistent");
    expect(retrieved).toBeUndefined();
  });

  it("should list all providers", () => {
    const provider1 = createMockProvider("provider1");
    const provider2 = createMockProvider("provider2");

    catalog.register(provider1);
    catalog.register(provider2);

    const all = catalog.all();
    expect(all.length).toBe(2);
  });

  it("should use adapters as a map", () => {
    const provider = createMockProvider("test");
    catalog.register(provider);

    expect(catalog.adapters.has("test")).toBe(true);
    expect(catalog.adapters.size).toBe(1);
  });
});

describe("ProviderError", () => {
  it("should create error with message", () => {
    const error = new ProviderError("Something went wrong");
    expect(error.message).toBe("Something went wrong");
    expect(error.name).toBe("ProviderError");
  });

  it("should create error with code and retryable flag", () => {
    const error = new ProviderError("Rate limited", "rate_limit", true);
    expect(error.code).toBe("rate_limit");
    expect(error.retryable).toBe(true);
  });
});

describe("ScriptedTestProvider", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
  });

  it("should stream responses", async () => {
    const provider = new ScriptedTestProvider({
      providerId: "scripted",
      steps: [],
    });

    const events: StreamEvent[] = [];
    for await (const event of provider.streamChat({
      model: "test",
      messages: [{ role: "user", content: "Hello" }],
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "finish")).toBe(true);
  });
});

describe("TestProviderIsolationError", () => {
  it("should create error with providerId", () => {
    const error = new TestProviderIsolationError("evil-provider");
    expect(error.message).toContain("evil-provider");
    expect(error.message).toContain("Refusing to register test provider");
    expect(error.name).toBe("TestProviderIsolationError");
  });
});
