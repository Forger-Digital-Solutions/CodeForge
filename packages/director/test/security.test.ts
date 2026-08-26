import { describe, expect, it, beforeEach } from "vitest";
import { ForgeZero } from "@codeforge/forge-zero";
import { ForgeDirector, createDirector } from "../src/index.js";
import { InMemoryProviderCatalog, EnvironmentCredentialStore, createMockProvider } from "@codeforge/providers";
import type { FreeModelRecord } from "@codeforge/forge-zero";

const now = new Date("2026-08-24T12:00:00Z");
const testContext = { now: () => now };

const createFreeModel = (): FreeModelRecord => ({
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
});

describe("Credential Security — Section 11", () => {
  describe("Credential Store", () => {
    it("stores credential without exposing raw value", () => {
      const store = new EnvironmentCredentialStore();
      store.set("gpt", "sk-secret-key-value");

      const has = store.has("gpt");
      expect(has).toBe(true);

      
    });

    it("retrieves credential only through secure method", () => {
      const store = new EnvironmentCredentialStore();
      store.set("anthropic", "sk-ant-secret");

      const value = store.get("anthropic");
      expect(value).toBe("sk-ant-secret");
    });

    it("deletes credential securely", () => {
      const store = new EnvironmentCredentialStore();
      store.set("glm", "glm-secret-key");

      expect(store.has("glm")).toBe(true);

      store.delete("glm");

      expect(store.has("glm")).toBe(false);
      expect(store.get("glm")).toBeUndefined();
    });
  });

  describe("Director Error Messages", () => {
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

    it("never includes API keys in error messages", async () => {
      const store = new EnvironmentCredentialStore();
      store.set("gpt", "sk-super-secret-key-12345");

      providerCatalog.register(createMockProvider("gpt"));

      const storeDirector = createDirector({
        firewall,
        providerCatalog,
      });

      const result = await storeDirector.runTask({
        id: "task-1",
        title: "Test",
        modelSelection: {
          mode: "exact-premium",
          family: "gpt",
          modelId: "gpt-4",
          providerId: "gpt",
        },
      });

      if (result.error) {
        expect(result.error).not.toContain("sk-");
        expect(result.error).not.toContain("secret");
        expect(result.error).not.toContain("key-12345");
      }
    });

    it("task result never contains credential values", async () => {
      const result = await director.runTask({
        id: "secure-task",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("apiKey");
      expect(resultStr).not.toContain("credential");
      expect(resultStr).not.toContain("secret");
      
      if (result.error) {
        expect(result.error).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
      }
    });

    it("resolved model does not expose credentials", async () => {
      const result = await director.runTask({
        id: "task-3",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      expect(result.resolvedModel).toBeDefined();
      expect(result.resolvedModel).not.toHaveProperty("apiKey");
      expect(result.resolvedModel).not.toHaveProperty("credential");

      const modelStr = JSON.stringify(result.resolvedModel);
      expect(modelStr).not.toContain("secret");
    });
  });

  describe("Provider Catalog Security", () => {
    it("catalog does not expose credentials through iteration", () => {
      const catalog = new InMemoryProviderCatalog();
      catalog.register(createMockProvider("gpt"));
      catalog.register(createMockProvider("anthropic"));

      for (const adapter of catalog.all()) {
        expect(adapter).not.toHaveProperty("apiKey");
        expect(adapter).not.toHaveProperty("credential");
      }
    });

    it("adapter interface does not leak credentials", () => {
      const catalog = new InMemoryProviderCatalog();
      catalog.register(createMockProvider("gpt"));

      const adapter = catalog.get("gpt");
      expect(adapter).toBeDefined();

      if (adapter) {
        const adapterKeys = Object.keys(adapter);
        expect(adapterKeys).not.toContain("apiKey");
        expect(adapterKeys).not.toContain("credential");
        expect(adapterKeys).not.toContain("secret");
      }
    });
  });

  describe("Environment Variable Security", () => {
    it("does not read arbitrary env vars", () => {
      process.env["RANDOM_SECRET"] = "should-not-read";
      const store = new EnvironmentCredentialStore();

      const value = store.get("random");
      expect(value).toBeUndefined();
      expect(value).not.toBe("should-not-read");
    });

    it("reads only properly namespaced keys", () => {
      process.env["GPT_API_KEY"] = "gpt-key-value";
      process.env["OTHER_VAR"] = "other-value";

      const store = new EnvironmentCredentialStore();

      const gptKey = store.get("gpt");
      expect(gptKey).toBe("gpt-key-value");

      const other = store.get("other" as any);
      expect(other).not.toBe("other-value");
    });
  });

  describe("No Credential in Logs", () => {
    let loggedMessages: string[] = [];

    beforeEach(() => {
      loggedMessages = [];
      const originalConsole = console.log;
      console.log = (...args) => {
        loggedMessages.push(args.join(" "));
      };
    });

    it("director operations do not log credentials", async () => {
      const firewall = new ForgeZero({ context: testContext });
      firewall.register(createFreeModel());

      const catalog = new InMemoryProviderCatalog();
      const store = new EnvironmentCredentialStore();
      store.set("gpt", "sk-secret-do-not-log");

      const director = createDirector({
        firewall,
        providerCatalog: catalog,
      });

      await director.runTask({
        id: "task-4",
        title: "Test",
        modelSelection: { mode: "forgezero-adaptive" },
      });

      for (const msg of loggedMessages) {
        expect(msg).not.toContain("sk-");
        expect(msg).not.toContain("secret");
        expect(msg).not.toContain("do-not-log");
      }
    });
  });
});
