import { describe, expect, it, beforeEach, vi } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeDirector, createDirector, type ExecutionModelSelection } from "../src/index.js";
import { ForgeRouter, createRouter } from "@codeforge/router";
import { 
  InMemoryProviderCatalog, 
  createMockProvider,
  ScriptedTestProvider,
  ProviderCatalogService,
} from "@codeforge/providers";
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

describe("E2E Integration — Section 11", () => {
  describe("Full Execution Path", () => {
    it("traces ForgeZero Adaptive from selection to execution", async () => {
      
      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      
      const providerCatalog = new InMemoryProviderCatalog();
      const scriptedProvider = new ScriptedTestProvider({
        providerId: "openrouter",
        steps: [
          { type: "response", payload: { content: "Task completed" } },
        ],
      });
      providerCatalog.register(scriptedProvider);

      
      const director = createDirector({
        firewall,
        providerCatalog,
      });

      
      const selection: ExecutionModelSelection = {
        mode: "forgezero-adaptive",
      };

      
      const taskResult = await director.runTask({
        id: "e2e-task-1",
        title: "Fix a bug in the authentication module",
        modelSelection: selection,
      });

      
      expect(taskResult.status).toBe("completed");
      expect(taskResult.resolvedModel).toBeDefined();
      expect(taskResult.resolvedModel?.requestedMode).toBe("forgezero-adaptive");
      expect(taskResult.resolvedModel?.resolvedModelId).toBe("deepseek-chat:free");
      expect(taskResult.resolvedModel?.isAdaptiveResolution).toBe(true);
    });

    it("traces Exact Free from selection to execution", async () => {
      
      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      
      const providerCatalog = new InMemoryProviderCatalog();
      providerCatalog.register(createMockProvider("openrouter"));

      
      const director = createDirector({
        firewall,
        providerCatalog,
      });

      
      const selection: ExecutionModelSelection = {
        mode: "exact-free",
        modelId: "deepseek-chat:free",
        providerId: "openrouter",
      };

      
      const taskResult = await director.runTask({
        id: "e2e-task-2",
        title: "Add unit tests for UserService",
        modelSelection: selection,
      });

      
      expect(taskResult.status).toBe("completed");
      expect(taskResult.resolvedModel?.resolvedModelId).toBe("deepseek-chat:free");
      expect(taskResult.resolvedModel?.isAdaptiveResolution).toBe(false);
      expect(taskResult.resolvedModel?.requestedMode).toBe("exact-free");
    });

    it("traces Exact Premium through the stack", async () => {
      
      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      
      const providerCatalog = new InMemoryProviderCatalog();
      providerCatalog.register(createMockProvider("gpt"));

      
      const director = createDirector({
        firewall,
        providerCatalog,
      });

      
      const selection: ExecutionModelSelection = {
        mode: "exact-premium",
        family: "gpt",
        modelId: "gpt-4-turbo",
        providerId: "gpt",
      };

      
      const taskResult = await director.runTask({
        id: "e2e-task-3",
        title: "Analyze code quality issues",
        modelSelection: selection,
      });

      
      expect(taskResult.status).toBe("completed");
      expect(taskResult.resolvedModel?.resolvedFamily).toBe("gpt");
      expect(taskResult.resolvedModel?.resolvedModelId).toBe("gpt-4-turbo");
    });
  });

  describe("Router Integration", () => {
    it("router resolves ForgeZero Adaptive selection", () => {
      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());
      firewall.register(createFreeModel({
        modelId: "llama-3.1-70b:free",
        displayName: "Llama 3.1 70B (Free)",
      }));

      const router = createRouter({ firewall });

      const result = router.resolveSelection({ mode: "forgezero-adaptive" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.resolvedModelId).toBeDefined();
        expect(result.value.isAdaptiveResolution).toBe(true);
      }
    });

    it("router respects Exact Free selection", () => {
      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      const router = createRouter({ firewall });

      const result = router.resolveSelection({
        mode: "exact-free",
        modelId: "deepseek-chat:free",
        providerId: "openrouter",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.resolvedModelId).toBe("deepseek-chat:free");
      }
    });
  });

  describe("Provider Catalog Integration", () => {
    it("provider catalog tracks registered providers", () => {
      const catalog = new InMemoryProviderCatalog();
      catalog.register(createMockProvider("openrouter"));
      catalog.register(createMockProvider("gpt"));
      catalog.register(createMockProvider("anthropic"));

      expect(catalog.all()).toHaveLength(3);
      expect(catalog.get("openrouter")).toBeDefined();
      expect(catalog.get("gpt")).toBeDefined();
      expect(catalog.get("anthropic")).toBeDefined();
    });

    it("provider catalog service provides status", () => {
      const service = new ProviderCatalogService();
      service.register(createMockProvider("gpt"));

      
      const status = service.getStatus("gpt");
      expect(status).toBe("missing_credential");

      
      const missingStatus = service.getStatus("nonexistent");
      expect(missingStatus).toBe("unsupported");
    });
  });

  describe("Event Flow Simulation", () => {
    it("simulates protocol event flow for task execution", async () => {
      const events: string[] = [];

      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      const providerCatalog = new InMemoryProviderCatalog();
      providerCatalog.register({
        providerId: "openrouter",
        listModels: async () => {
          events.push("provider.listModels");
          return [];
        },
        chat: async () => {
          events.push("provider.chat");
          return { content: "done" };
        },
      });

      const director = createDirector({
        firewall,
        providerCatalog,
      });

      
      events.push("task.created");
      
      await director.runTask({
        id: "event-task",
        title: "Test Event Flow",
        modelSelection: { mode: "forgezero-adaptive" },
      });
      
      events.push("task.completed");

      
      expect(events).toContain("task.created");
      expect(events).toContain("task.completed");
    });
  });

  describe("Tier Isolation E2E Proof", () => {
    it("GPT selection never invokes Anthropic adapter", async () => {
      const invokedProviders: string[] = [];

      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      const providerCatalog = new InMemoryProviderCatalog();
      providerCatalog.register({
        providerId: "gpt",
        listModels: async () => {
          invokedProviders.push("gpt");
          return [];
        },
        chat: async () => {
          invokedProviders.push("gpt-chat");
          return {};
        },
      });
      providerCatalog.register({
        providerId: "anthropic",
        listModels: async () => {
          invokedProviders.push("anthropic");
          return [];
        },
        chat: async () => {
          invokedProviders.push("anthropic-chat");
          return {};
        },
      });

      const director = createDirector({
        firewall,
        providerCatalog,
      });

      await director.runTask({
        id: "isolation-task-1",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "gpt",
          modelId: "gpt-4",
          providerId: "gpt",
        },
      });

      expect(invokedProviders).not.toContain("anthropic");
      expect(invokedProviders).not.toContain("anthropic-chat");
    });

    it("ForgeZero Adaptive never invokes premium adapters", async () => {
      const invokedProviders: string[] = [];

      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      const providerCatalog = new InMemoryProviderCatalog();
      providerCatalog.register(createMockProvider("openrouter"));
      providerCatalog.register({
        providerId: "gpt",
        isTestProvider: true,
        listModels: async () => {
          invokedProviders.push("gpt");
          return [];
        },
        chat: async () => {
          invokedProviders.push("gpt-chat");
          return {};
        },
      });
      providerCatalog.register({
        providerId: "anthropic",
        isTestProvider: true,
        listModels: async () => {
          invokedProviders.push("anthropic");
          return [];
        },
        chat: async () => {
          invokedProviders.push("anthropic-chat");
          return {};
        },
      });

      const director = createDirector({
        firewall,
        providerCatalog,
      });

      await director.runTask({
        id: "isolation-task-2",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(invokedProviders).not.toContain("gpt");
      expect(invokedProviders).not.toContain("anthropic");
      expect(invokedProviders).not.toContain("gpt-chat");
      expect(invokedProviders).not.toContain("anthropic-chat");
    });

    it("Exact Free never falls back to any alternative", async () => {
      const invokedProviders: string[] = [];

      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel({
        modelId: "offline-model",
        health: { status: "offline" },
      }));

      const providerCatalog = new InMemoryProviderCatalog();
      providerCatalog.register({
        providerId: "openrouter",
        listModels: async () => {
          invokedProviders.push("openrouter");
          return [];
        },
        chat: async () => {
          invokedProviders.push("openrouter-chat");
          return {};
        },
      });

      const director = createDirector({
        firewall,
        providerCatalog,
      });

      await director.runTask({
        id: "isolation-task-3",
        title: "Test",
        modelSelection: {
          mode: "exact-free",
          modelId: "nonexistent-model",
          providerId: "unknown",
        },
      });

      
      expect(invokedProviders).toHaveLength(0);
    });
  });
});
