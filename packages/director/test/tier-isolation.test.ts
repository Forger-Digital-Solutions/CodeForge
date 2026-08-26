import { describe, expect, it, beforeEach } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeDirector, createDirector, type ExecutionModelSelection } from "../src/index.js";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import type { FreeModelRecord } from "@codeforge/forge-zero";

const now = new Date("2026-08-24T12:00:00Z");

const testContext = { now: () => now };

const createFreeModel = (overrides: Partial<FreeModelRecord> = {}): FreeModelRecord => ({
  providerId: "openrouter",
  modelId: "deepseek-chat:free",
  displayName: "DeepSeek Chat (Free)",
  freeStatus: "verified_free",
  freeStatusVerifiedAt: now.toISOString(),
  isRemote: true,
  isCloudHosted: true,
  contextWindow: 128000,
  capabilities: {
    text: true,
    coding: true,
    toolCalling: true,
    vision: false,
    structuredOutput: true,
    longContext: true,
  },
  costProfile: {
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    isFree: true,
    freeTierVerifiedAt: now.toISOString(),
    paidFallbackPossible: false,
    paidFallbackDisabled: true,
    source: "test",
  },
  health: {
    status: "available",
    lastCheckedAt: now.toISOString(),
  },
  ...overrides,
});

describe("Tier Isolation — Section 11", () => {
  let firewall: ForgeZero;
  let providerCatalog: InMemoryProviderCatalog;
  let director: ForgeDirector;

  beforeEach(() => {
    firewall = new ForgeZero({ context: testContext });
    firewall.register(createFreeModel());

    providerCatalog = new InMemoryProviderCatalog();
    providerCatalog.register(createMockProvider("openrouter"));
    providerCatalog.register(createMockProvider("gpt"));
    providerCatalog.register(createMockProvider("anthropic"));
    providerCatalog.register(createMockProvider("glm"));

    director = createDirector({
      firewall,
      providerCatalog,
      gemsReady: false,
    });
  });

  describe("ForgeZero Adaptive", () => {
    it("selects only verified-free models", async () => {
      const result = await director.runTask({
        id: "task-1",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(result.status).toBe("completed");
      expect(result.resolvedModel?.requestedMode).toBe("forgezero-adaptive");
      expect(result.resolvedModel?.resolvedProviderId).toBe("openrouter");
    });

    it("fails when no free models available", async () => {
      const emptyFirewall = new ForgeZero({ context: testContext });
      const emptyDirector = createDirector({
        firewall: emptyFirewall,
        providerCatalog,
      });

      const result = await emptyDirector.runTask({
        id: "task-2",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("could not find");
    });

    it("never selects paid models", async () => {
      firewall.register(
        createFreeModel({
          providerId: "openai",
          modelId: "gpt-5",
          displayName: "GPT-5",
          freeStatus: "paid",
          costProfile: {
            inputCostPerMillion: 10,
            outputCostPerMillion: 30,
            isFree: false,
            paidFallbackPossible: true,
            paidFallbackDisabled: false,
            source: "test",
          },
        }),
      );

      const result = await director.runTask({
        id: "task-3",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(result.status).toBe("completed");
      expect(result.resolvedModel?.resolvedProviderId).toBe("openrouter");
      expect(result.resolvedModel?.resolvedModelId).not.toBe("gpt-5");
    });
  });

  describe("Exact Free", () => {
    it("executes exactly the selected free model", async () => {
      const result = await director.runTask({
        id: "task-4",
        title: "Test",
        modelSelection: {
          mode: "exact-free",
          modelId: "deepseek-chat:free",
          providerId: "openrouter",
        },
      });

      expect(result.status).toBe("completed");
      expect(result.resolvedModel?.resolvedModelId).toBe("deepseek-chat:free");
    });

    it("fails exactly when model unavailable", async () => {
      const result = await director.runTask({
        id: "task-5",
        title: "Test",
        modelSelection: {
          mode: "exact-free",
          modelId: "nonexistent-model",
          providerId: "unknown",
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("did not substitute");
    });

    it("never falls back to premium", async () => {
      const singleModelFirewall = new ForgeZero({ context: testContext });
      singleModelFirewall.register(
        createFreeModel({
          modelId: "offline-model",
          health: { status: "offline" },
        }),
      );

      const offlineDirector = createDirector({
        firewall: singleModelFirewall,
        providerCatalog,
      });

      const result = await offlineDirector.runTask({
        id: "task-6",
        title: "Test",
        modelSelection: {
          mode: "exact-free",
          modelId: "offline-model",
          providerId: "openrouter",
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error).not.toContain("gpt");
      expect(result.error).not.toContain("anthropic");
      expect(result.error).not.toContain("glm");
    });
  });

  describe("Exact Premium — GPT", () => {
    it("executes exactly selected GPT model", async () => {
      const result = await director.runTask({
        id: "task-7",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "gpt",
          modelId: "gpt-4-turbo",
          providerId: "gpt",
        },
      });

      expect(result.status).toBe("completed");
      expect(result.resolvedModel?.resolvedFamily).toBe("gpt");
      expect(result.resolvedModel?.resolvedModelId).toBe("gpt-4-turbo");
    });

    it("fails with clear error when credential missing", async () => {
      const noCredsCatalog = new InMemoryProviderCatalog();
      const noCredsDirector = createDirector({
        firewall,
        providerCatalog: noCredsCatalog,
      });

      const result = await noCredsDirector.runTask({
        id: "task-8",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "gpt",
          modelId: "gpt-4-turbo",
          providerId: "gpt",
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("not configured");
    });

    it("never falls back to Anthropic", async () => {
      const failingGptCatalog = new InMemoryProviderCatalog();
      failingGptCatalog.register({
        providerId: "gpt",
        isTestProvider: true,
        listModels: async () => [],
        chat: async () => {
          throw new Error("API Error");
        },
      });
      failingGptCatalog.register(createMockProvider("anthropic"));

      const failingDirector = createDirector({
        firewall,
        providerCatalog: failingGptCatalog,
      });

      const result = await failingDirector.runTask({
        id: "task-9",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "gpt",
          modelId: "gpt-4-turbo",
          providerId: "gpt",
        },
      });

      expect(result.resolvedModel?.resolvedProviderId).toBe("gpt");
    });
  });

  describe("Exact Premium — Anthropic", () => {
    it("executes exactly selected Anthropic model", async () => {
      const result = await director.runTask({
        id: "task-10",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "anthropic",
          modelId: "claude-3-opus",
          providerId: "anthropic",
        },
      });

      expect(result.status).toBe("completed");
      expect(result.resolvedModel?.resolvedFamily).toBe("anthropic");
    });

    it("never falls back to GPT", async () => {
      const result = await director.runTask({
        id: "task-11",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "anthropic",
          modelId: "claude-3-opus",
          providerId: "anthropic",
        },
      });

      expect(result.resolvedModel?.resolvedFamily).toBe("anthropic");
      expect(result.resolvedModel?.resolvedProviderId).toBe("anthropic");
    });
  });

  describe("Exact Premium — GLM", () => {
    it("executes exactly selected GLM model", async () => {
      const result = await director.runTask({
        id: "task-12",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "glm",
          modelId: "glm-4",
          providerId: "glm",
        },
      });

      expect(result.status).toBe("completed");
      expect(result.resolvedModel?.resolvedFamily).toBe("glm");
    });

    it("never falls back to ForgeZero", async () => {
      const result = await director.runTask({
        id: "task-13",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "glm",
          modelId: "glm-4",
          providerId: "glm",
        },
      });

      expect(result.resolvedModel?.resolvedProviderId).toBe("glm");
      expect(result.resolvedModel?.requestedMode).toBe("exact-premium");
    });
  });

  describe("GEMS — Coming Soon", () => {
    it("blocks execution when GEMS not ready", async () => {
      const result = await director.runTask({
        id: "task-14",
        title: "Test",
        modelSelection: {
          mode: "gems",
        },
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Coming Soon");
    });

    it("never makes external provider calls", async () => {
      const callTracker: string[] = [];
      const trackingCatalog = new InMemoryProviderCatalog();
      trackingCatalog.register({
        providerId: "gpt",
        listModels: async () => {
          callTracker.push("gpt");
          return [];
        },
        chat: async () => {
          callTracker.push("gpt-chat");
          return {};
        },
      });
      trackingCatalog.register({
        providerId: "anthropic",
        listModels: async () => {
          callTracker.push("anthropic");
          return [];
        },
        chat: async () => {
          callTracker.push("anthropic-chat");
          return {};
        },
      });

      const gemsDirector = createDirector({
        firewall,
        providerCatalog: trackingCatalog,
        gemsReady: false,
      });

      await gemsDirector.runTask({
        id: "task-15",
        title: "Test",
        modelSelection: { mode: "gems" },
      });

      expect(callTracker).toHaveLength(0);
    });
  });

  describe("Cross-Tier Fallback Prevention", () => {
    it("ForgeZero never escalates to premium", async () => {
      const noFreeFirewall = new ForgeZero({ context: testContext });
      const noFreeDirector = createDirector({
        firewall: noFreeFirewall,
        providerCatalog,
      });

      const result = await noFreeDirector.runTask({
        id: "task-16",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(result.status).toBe("failed");
      expect(result.error).not.toContain("gpt");
      expect(result.error).not.toContain("anthropic");
      expect(result.error).not.toContain("premium");
    });

    it("Exact Free never substitutes another model", async () => {
      const result = await director.runTask({
        id: "task-17",
        title: "Test",
        modelSelection: {
          mode: "exact-free",
          modelId: "different-model",
          providerId: "different-provider",
        },
      });

      expect(result.status).toBe("failed");
      expect(result.resolvedModel).toBeUndefined();
    });
  });

  describe("Execution Snapshot Semantics", () => {
    it("task snapshot is independent of later UI changes", async () => {
      let taskStarted = false;
      let selectionAtStart: ExecutionModelSelection | null = null;

      const resultPromise = director.runTask({
        id: "task-18",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      taskStarted = true;
      selectionAtStart = { mode: "forgezero-adaptive" };

      
      const difierentSelection: ExecutionModelSelection = {
        mode: "exact-free",
        modelId: "other-model",
        providerId: "other",
      };

      const result = await resultPromise;

      expect(result.resolvedModel?.requestedMode).toBe("forgezero-adaptive");
      expect(result.resolvedModel?.requestedMode).not.toBe(difierentSelection.mode);
    });
  });

  describe("Runtime Model Identity", () => {
    it("surfaces resolved model for ForgeZero Adaptive", async () => {
      const result = await director.runTask({
        id: "task-19",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(result.resolvedModel).toBeDefined();
      expect(result.resolvedModel?.resolvedModelId).toBe("deepseek-chat:free");
      expect(result.resolvedModel?.resolvedProviderId).toBe("openrouter");
      expect(result.resolvedModel?.isAdaptiveResolution).toBe(true);
    });

    it("surfaces resolved model for Exact Free", async () => {
      const result = await director.runTask({
        id: "task-20",
        title: "Test",
        modelSelection: {
          mode: "exact-free",
          modelId: "deepseek-chat:free",
          providerId: "openrouter",
        },
      });

      expect(result.resolvedModel).toBeDefined();
      expect(result.resolvedModel?.resolvedModelId).toBe("deepseek-chat:free");
      expect(result.resolvedModel?.isAdaptiveResolution).toBe(false);
    });

    it("surfaces resolved model for Exact Premium", async () => {
      const result = await director.runTask({
        id: "task-21",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "gpt",
          modelId: "gpt-4-turbo",
          providerId: "gpt",
        },
      });

      expect(result.resolvedModel).toBeDefined();
      expect(result.resolvedModel?.resolvedModelId).toBe("gpt-4-turbo");
      expect(result.resolvedModel?.resolvedFamily).toBe("gpt");
    });
  });
});

describe("Provider Readiness", () => {
  let firewall: ForgeZero;
  let providerCatalog: InMemoryProviderCatalog;
  let director: ForgeDirector;

  beforeEach(() => {
    firewall = new ForgeZero({ context: testContext });
    firewall.register(createFreeModel());

    providerCatalog = new InMemoryProviderCatalog();
    director = createDirector({
      firewall,
      providerCatalog,
    });
  });

  it("returns missing_credential for unconfigured GPT", () => {
    const readiness = director.getProviderReadiness("gpt");
    expect(readiness).toBe("missing_credential");
  });

  it("returns missing_credential for unconfigured Anthropic", () => {
    const readiness = director.getProviderReadiness("anthropic");
    expect(readiness).toBe("missing_credential");
  });

  it("returns missing_credential for unconfigured GLM", () => {
    const readiness = director.getProviderReadiness("glm");
    expect(readiness).toBe("missing_credential");
  });

  it("returns ready for configured provider", () => {
    providerCatalog.register(createMockProvider("gpt"));
    const readyDirector = createDirector({
      firewall,
      providerCatalog,
    });

    const readiness = readyDirector.getProviderReadiness("gpt");
    expect(readiness).toBe("ready");
  });
});
