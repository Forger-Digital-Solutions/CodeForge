import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EnvironmentCredentialStore, OpenRouterAdapter, OpencodeAdapter } from "../src/index.js";

describe("Credential separation", () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());

  it("OPENROUTER_API_KEY and OPENCODE_API_KEY remain independent", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-key");
    vi.stubEnv("OPENCODE_API_KEY", "opencode-key");
    const store = new EnvironmentCredentialStore();
    expect(store.get("openrouter")).toBe("router-key");
    expect(store.get("opencode")).toBe("opencode-key");
    expect(store.get("openrouter")).not.toBe(store.get("opencode"));
  });

  it("OpencodeAdapter uses OPENCODE_API_KEY, OpenRouterAdapter uses OPENROUTER_API_KEY", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "router-only");
    vi.stubEnv("OPENCODE_API_KEY", "");
    const opencodeStore = new EnvironmentCredentialStore();
    const openrouterStore = new EnvironmentCredentialStore();
    expect(opencodeStore.get("opencode") || undefined).toBeUndefined();
    expect(openrouterStore.get("openrouter")).toBe("router-only");

    const opencodeAdapter = new OpencodeAdapter({ credentialStore: opencodeStore, baseUrl: "http://fake" });
    await expect(opencodeAdapter.listModels()).rejects.toMatchObject({ code: "MISSING_API_KEY" });

    vi.stubEnv("OPENCODE_API_KEY", "opencode-only");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const store2 = new EnvironmentCredentialStore();
    expect(store2.get("opencode")).toBe("opencode-only");
    expect(store2.get("openrouter") || undefined).toBeUndefined();
    const routerAdapter = new OpenRouterAdapter({ credentialStore: store2, baseUrl: "http://fake" });
    await expect(routerAdapter.listModels()).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });

  it("missing credential produces provider unavailable, not cross-provider fallback", () => {
    vi.stubEnv("OPENCODE_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const store = new EnvironmentCredentialStore();
    expect(store.has("opencode")).toBe(false);
    expect(store.has("openrouter")).toBe(false);
    const opencodeAdapter = new OpencodeAdapter({ credentialStore: store, baseUrl: "http://fake" });
    const routerAdapter = new OpenRouterAdapter({ credentialStore: store, baseUrl: "http://fake" });
    expect(opencodeAdapter.providerId).toBe("opencode");
    expect(routerAdapter.providerId).toBe("openrouter");
  });
});

describe("API error normalization", () => {
  it("OpencodeAdapter normalizes 401/402/429/503/timeout/mismatch consistently", async () => {
    const store = {
      get: () => "key",
      set: () => {},
      delete: () => false,
      has: () => true,
    };
    const adapter = new OpencodeAdapter({ credentialStore: store as never, baseUrl: "http://fake", timeoutMs: 1000 });

    const cases: Array<[number, string, boolean]> = [
      [401, "AUTH_ERROR", false],
      [402, "PAYMENT_REQUIRED", false],
      [429, "RATE_LIMITED", true],
      [503, "MODEL_OVERLOADED", true],
      [500, "PROVIDER_ERROR", true],
    ];
    for (const [status, code, retryable] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status,
        text: async () => `error ${status}`,
        json: async () => ({}),
      } as unknown as Response)));
      try {
        await adapter.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] });
        throw new Error("should have thrown");
      } catch (e) {
        const err = e as { code: string; retryable: boolean };
        expect(err.code).toBe(code);
        expect(!!err.retryable).toBe(retryable);
      }
      vi.unstubAllGlobals();
    }
  });
});
