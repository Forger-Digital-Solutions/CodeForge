import { describe, it, expect } from "vitest";
import { normalizeProviderError, ModelExecutionAdapter } from "../src/model-execution-adapter.js";
import { ERROR_CODES } from "@codeforge/agent";
import { InMemoryProviderCatalog, type ProviderAdapter } from "@codeforge/providers";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";

describe("Model Execution Adapter & Provider Contract (CF-07)", () => {
  it("normalizes provider errors into deterministic CodeForge error codes", () => {
    expect(normalizeProviderError(new Error("401 Unauthorized: invalid api key")).code).toBe(ERROR_CODES.PROVIDER_AUTH_FAILED);
    expect(normalizeProviderError(new Error("429 Too Many Requests: quota exceeded")).code).toBe(ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(normalizeProviderError(new Error("ETIMEDOUT: connect timeout after 30000ms")).code).toBe(ERROR_CODES.PROVIDER_TIMEOUT);
    expect(normalizeProviderError(new Error("maximum context length is 128000 tokens")).code).toBe(ERROR_CODES.PROVIDER_CONTEXT_LIMIT);
    expect(normalizeProviderError(new Error("model unavailable: model not found")).code).toBe(ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE);
    expect(normalizeProviderError(new Error("stream interrupted by server")).code).toBe(ERROR_CODES.PROVIDER_STREAM_INTERRUPTED);
  });

  it("fails closed without silent model substitution when exact model is requested but unavailable", async () => {
    const catalog = new InMemoryProviderCatalog();
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());

    const adapter = new ModelExecutionAdapter(catalog, firewall);

    expect(() => {
      adapter.resolveModel({ providerId: "missing-provider", modelId: "claude-3-5-sonnet" });
    }).toThrow(/PROVIDER_MODEL_UNAVAILABLE/);
  });

  it("fails closed before invoking a registered provider when its exact model is absent from ForgeZero", async () => {
    const catalog = new InMemoryProviderCatalog();
    let calls = 0;
    catalog.register({
      providerId: "managed-free-provider",
      isTestProvider: true,
      listModels: async () => [],
      chat: async () => { throw new Error("Use streamChat"); },
      streamChat: async function* () {
        calls += 1;
        yield { type: "text_delta", delta: "must not execute" };
        yield { type: "finish", finishReason: "stop" };
      },
      healthCheck: async () => ({ status: "available" }),
    });
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord());
    const adapter = new ModelExecutionAdapter(catalog, firewall);

    await expect(adapter.execute({
      modelSelection: { providerId: "managed-free-provider", modelId: "unqualified-or-paid-model" },
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow(/not registered in ForgeZero/);
    expect(calls).toBe(0);
  });

  it("executes through direct BYOK adapter independently", async () => {
    const catalog = new InMemoryProviderCatalog();
    const mockDirectProvider: ProviderAdapter = {
      providerId: "byok-openrouter",
      isTestProvider: true,
      listModels: async () => [{ modelId: "free-model", displayName: "Free", isFree: true, freeStatus: "verified_free", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true } }],
      chat: async () => { throw new Error("Use streamChat"); },
      streamChat: async function* () {
        yield { type: "text_delta", delta: "Direct BYOK response." };
        yield { type: "finish", finishReason: "stop" };
      },
      healthCheck: async () => ({ status: "available" }),
    };

    catalog.register(mockDirectProvider);
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({
      providerId: "byok-openrouter",
      modelId: "free-model",
      displayName: "Direct Free Model",
      contextWindow: 64000,
      capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    }));

    const adapter = new ModelExecutionAdapter(catalog, firewall);
    const response = await adapter.execute({
      modelSelection: { providerId: "byok-openrouter", modelId: "free-model" },
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(response.text).toBe("Direct BYOK response.");
    expect(response.providerId).toBe("byok-openrouter");
  });
});
