import { describe, it, expect } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import {
  type ProviderAdapter,
  type ProviderModel,
  type ChatRequest,
  type ChatResponse,
  type StreamEvent,
  InMemoryProviderCatalog,
  ProviderCapacityGovernor,
} from "@codeforge/providers";
import { ERROR_CODES } from "@codeforge/agent";
import { createModelExecutionAdapter } from "../src/model-execution-adapter.js";

class ConcurrencyTrackingProvider implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = true;
  activeExecutions = 0;
  maxActiveSeen = 0;
  totalCalls = 0;
  delayMs: number;

  constructor(providerId: string, delayMs = 20) {
    this.providerId = providerId;
    this.delayMs = delayMs;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [
      {
        modelId: "test-fast",
        displayName: "Test Fast Model",
        isFree: true,
        freeStatus: "verified_free",
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
      },
    ];
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("Use streamChat");
  }

  async *streamChat(_req: ChatRequest, _signal?: AbortSignal): AsyncIterable<StreamEvent> {
    this.totalCalls++;
    this.activeExecutions++;
    if (this.activeExecutions > this.maxActiveSeen) {
      this.maxActiveSeen = this.activeExecutions;
    }

    try {
      if (this.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.delayMs));
      }
      yield { type: "text_delta", delta: "Generated code snippet" };
      yield {
        type: "usage",
        usage: { inputTokens: 500, outputTokens: 200 },
      };
      yield { type: "finish", finishReason: "stop" };
    } finally {
      this.activeExecutions--;
    }
  }
}

describe("ModelExecutionAdapter Concurrency & Fallback Safety", () => {
  it("prevents legacy fallback to modelId: 'default' when no eligible models exist", () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new ConcurrencyTrackingProvider("mock-provider");
    catalog.register(provider);

    // Empty firewall: no models registered as eligible
    const firewall = new ForgeZero();
    const adapter = createModelExecutionAdapter(catalog, firewall);

    expect(() => adapter.resolveModel()).toThrowError(
      new RegExp(ERROR_CODES.PROVIDER_MODEL_UNAVAILABLE),
    );
  });

  it("paces concurrent subagent requests through ProviderCapacityGovernor without exceeding maxConcurrent", async () => {
    const catalog = new InMemoryProviderCatalog();
    const provider = new ConcurrencyTrackingProvider("groq-mock", 30);
    catalog.register(provider);

    const firewall = new ForgeZero();
    firewall.register(
      createGenericFreeRecord({
        providerId: "groq-mock",
        modelId: "llama-3.3-70b",
      }),
    );

    // Governor with maxConcurrent = 2
    const governor = new ProviderCapacityGovernor({
      limits: {
        "groq-mock": {
          maxRequestsPerMinute: 60,
          maxTokensPerMinute: 50000,
          maxConcurrent: 2,
        },
      },
    });

    const adapter = createModelExecutionAdapter(catalog, firewall, undefined, governor);

    // Simulate 6 concurrent subagent executions (e.g. Explorer A, Explorer B, Planner, Coder, Reviewer, Verifier)
    const promises = Array.from({ length: 6 }, (_, i) =>
      adapter.execute({
        modelSelection: { providerId: "groq-mock", modelId: "llama-3.3-70b" },
        messages: [{ role: "user", content: `SubAgent task ${i}` }],
      }),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(6);
    for (const res of results) {
      expect(res.text).toBe("Generated code snippet");
      expect(res.usage.inputTokens).toBe(500);
    }

    // Provider should have never seen more than 2 concurrent active executions
    expect(provider.maxActiveSeen).toBeLessThanOrEqual(2);
    expect(provider.totalCalls).toBe(6);
  });

  it("records 429 rate limit in governor and initiates cooldown", async () => {
    class RateLimitedProvider implements ProviderAdapter {
      readonly providerId = "groq-429";
      readonly isTestProvider = true;

      async listModels(): Promise<ProviderModel[]> {
        return [];
      }
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        throw new Error("Use streamChat");
      }
      async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
        yield {
          type: "error",
          code: "PROVIDER_RATE_LIMITED",
          message: "Rate limit reached: 429 Too Many Requests. Try again in 2s.",
        };
      }
    }

    const catalog = new InMemoryProviderCatalog();
    catalog.register(new RateLimitedProvider());

    const firewall = new ForgeZero();
    firewall.register(
      createGenericFreeRecord({
        providerId: "groq-429",
        modelId: "test-model",
      }),
    );

    const governor = new ProviderCapacityGovernor();
    const adapter = createModelExecutionAdapter(catalog, firewall, undefined, governor);

    await expect(
      adapter.execute({
        modelSelection: { providerId: "groq-429", modelId: "test-model" },
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow();

    const report = governor.getCapacityReport("groq-429");
    expect(report.isCoolingDown).toBe(true);
    expect(report.cooldownRemainingMs).toBeGreaterThan(0);
  });

  it("routes to alternate free provider when primary is cooling down", () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new ConcurrencyTrackingProvider("groq-fast"));
    catalog.register(new ConcurrencyTrackingProvider("zai-fast"));

    const firewall = new ForgeZero();
    firewall.register(
      createGenericFreeRecord({
        providerId: "groq-fast",
        modelId: "llama-3.3-70b",
      }),
    );
    firewall.register(
      createGenericFreeRecord({
        providerId: "zai-fast",
        modelId: "glm-4.7-flash",
      }),
    );

    const governor = new ProviderCapacityGovernor();
    const adapter = createModelExecutionAdapter(catalog, firewall, undefined, governor);

    // Initial resolution selects zai-fast (deterministic ranking tiebreak glm < llama)
    const initial = adapter.resolveModel();
    expect(initial.providerId).toBe("zai-fast");
    expect(initial.modelId).toBe("glm-4.7-flash");

    // Z.AI hits 429 and enters cooldown
    governor.recordResponse("zai-fast", 429, { "retry-after": "10" });
    expect(governor.isCoolingDown("zai-fast")).toBe(true);

    // Dynamic resolution gracefully skips cooling down zai-fast and chooses groq-fast
    const routed = adapter.resolveModel();
    expect(routed.providerId).toBe("groq-fast");
    expect(routed.modelId).toBe("llama-3.3-70b");
  });

  it("strictly honors zero-billing firewall guarantee during adaptive routing (never routes to paid model)", () => {
    const catalog = new InMemoryProviderCatalog();
    catalog.register(new ConcurrencyTrackingProvider("paid-provider"));
    catalog.register(new ConcurrencyTrackingProvider("free-provider"));

    const firewall = new ForgeZero();
    // Register paid model with explicit paid costProfile
    firewall.register(
      createGenericFreeRecord({
        providerId: "paid-provider",
        modelId: "gpt-4o",
        tier: "gems_paid",
        costProfile: {
          isFree: false,
          inputCostPerMillion: 5.0,
          outputCostPerMillion: 15.0,
          cacheReadCostPerMillion: null,
          paidFallbackPossible: true,
          paidFallbackDisabled: false,
        },
      }),
    );
    // Register verified free model
    firewall.register(
      createGenericFreeRecord({
        providerId: "free-provider",
        modelId: "llama-free",
      }),
    );

    const governor = new ProviderCapacityGovernor();
    const adapter = createModelExecutionAdapter(catalog, firewall, undefined, governor);

    const resolved = adapter.resolveModel();
    expect(resolved.providerId).toBe("free-provider");
    expect(resolved.modelId).toBe("llama-free");

    // Even if free-provider enters cooldown and only paid-provider remains available in catalog
    governor.recordResponse("free-provider", 429, { "retry-after": "60" });
    const fallbackResolved = adapter.resolveModel();
    // Must STILL return free-provider (to queue/wait), NEVER paid-provider!
    expect(fallbackResolved.providerId).toBe("free-provider");
    expect(fallbackResolved.modelId).toBe("llama-free");
  });
});
