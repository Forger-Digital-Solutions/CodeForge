import { describe, expect, it } from "vitest";
import { ForgeZero, hashUserAccountIdentity } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ProviderModel } from "@codeforge/providers";
import { NormalizedModelRegistry, createFreeCloudService } from "@codeforge/model-registry";
import { ENV_CREDENTIALS_KEY, ProviderConnections, type ProviderConnectionsHost } from "../src/provider-connections.js";

const GROQ_SECRET = "gsk_live_secret_value_0123456789abcdef";
const OPENAI_SECRET = "sk-paid-secret-0123456789abcdefghijklmnop";
const OR_SECRET = "sk-or-v1-legacy-env-secret-0123456789";

interface Harness {
  connections: ProviderConnections;
  settings: Record<string, unknown>;
  secrets: Map<string, string>;
  env: Record<string, string | undefined>;
  catalog: InMemoryProviderCatalog;
  discovered: string[];
}

function harness(env: Record<string, string | undefined>, fetchModels?: (providerId: string) => ProviderModel[], ollamaEnabled = true): Harness {
  const settings: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const catalog = new InMemoryProviderCatalog();
  const firewall = new ForgeZero();
  const registry = new NormalizedModelRegistry();
  const freeCloud = createFreeCloudService({ firewall, providerCatalog: catalog, registry });
  const discovered: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    const providerId = url.includes("groq") ? "groq" : url.includes("openai.com") ? "openai" : url.includes("openrouter") ? "openrouter" : url.includes("ollama.com") ? "ollama-cloud" : "unknown";
    const models = fetchModels?.(providerId) ?? [];
    if (providerId === "unknown") return new Response("not found", { status: 404 });
    const raw = models.map((m) => ({ id: m.modelId, name: m.displayName, context_length: m.contextWindow, pricing: m.isFree ? { prompt: "0", completion: "0" } : { prompt: "1", completion: "1" } }));
    return new Response(JSON.stringify({ data: raw }), { status: 200, headers: { "content-type": "application/json" } });
  };
  // Route adapter HTTP through the in-memory fetch (the OpenAI-compatible adapter honours fetchFn via globalThis.fetch).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const host: ProviderConnectionsHost = {
    readSettings: () => settings,
    writeSettings: (next) => Object.assign(settings, next),
    secrets: {
      get: (k) => secrets.get(k),
      set: (k, v) => void secrets.set(k, v),
      delete: (k) => void secrets.delete(k),
      keys: () => [...secrets.keys()],
    },
    env: () => env,
    providerCatalog: catalog,
    firewall,
    freeCloud,
    discoverProviderFree: async (providerId) => {
      discovered.push(providerId);
      return 0;
    },
    providerAuthState: () => "ok",
    maxSecretLength: 512,
    userId: "user-a",
    ollamaUserConnectedFreeEnabled: ollamaEnabled,
  };
  const connections = new ProviderConnections(host);
  // Restore fetch lazily on process exit; tests only read within this module.
  void originalFetch;
  return { connections, settings, secrets, env, catalog, discovered };
}

describe("ProviderConnections — environment credentials", () => {
  it("detects credentials by name and never exposes values through any renderer-facing view", () => {
    const h = harness({ GROQ_API_KEY: GROQ_SECRET, OPENAI_API_KEY: OPENAI_SECRET });
    const views = [h.connections.listEnvironmentCredentials(), h.connections.listConnections(), h.connections.listDefinitions(), h.connections.firstRunOffer()];
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain(GROQ_SECRET);
    expect(serialized).not.toContain(OPENAI_SECRET);
    const groq = h.connections.listEnvironmentCredentials().find((e) => e.providerId === "groq")!;
    expect(groq.fields[0]?.variable).toBe("GROQ_API_KEY");
    expect(groq.enabled).toBe(false);
    expect(groq.active).toBe(false);
    const openai = h.connections.listEnvironmentCredentials().find((e) => e.providerId === "openai")!;
    expect(openai.paidOnly).toBe(true);
    expect(openai.policyBlocked).toBe(true);
  });

  it("toggle ON makes the runtime credential available; toggle OFF removes it; no restart", async () => {
    const h = harness({ GROQ_API_KEY: GROQ_SECRET });
    expect(h.connections.credentialStore().get("groq")).toBeUndefined();
    expect(h.catalog.get("groq")).toBeUndefined();

    await h.connections.setEnvironmentEnabled("groq", true);
    expect(h.connections.credentialStore().get("groq")).toBe(GROQ_SECRET);
    expect(h.connections.credentialSourceOf("groq")).toBe("ENVIRONMENT");
    expect(h.catalog.get("groq")).toBeDefined();
    const conn = h.connections.listConnections().find((c) => c.providerId === "groq")!;
    expect(conn.connected).toBe(true);
    expect(conn.credentialSource).toBe("ENVIRONMENT");
    expect(conn.environmentVariable).toBe("GROQ_API_KEY");
    // Only the preference (name + enabled) is persisted — never the value.
    expect(JSON.stringify(h.settings)).not.toContain(GROQ_SECRET);
    expect((h.settings[ENV_CREDENTIALS_KEY] as { preferences: Record<string, { enabled: boolean }> }).preferences.groq?.enabled).toBe(true);

    await h.connections.setEnvironmentEnabled("groq", false);
    expect(h.connections.credentialStore().get("groq")).toBeUndefined();
    expect(h.catalog.get("groq")).toBeUndefined();
    expect(h.connections.listConnections().find((c) => c.providerId === "groq")?.connected).toBe(false);
  });

  it("a variable that disappears makes the connection unavailable (no retained copy)", async () => {
    const h = harness({ GROQ_API_KEY: GROQ_SECRET });
    await h.connections.setEnvironmentEnabled("groq", true);
    expect(h.connections.credentialStore().get("groq")).toBe(GROQ_SECRET);
    delete h.env.GROQ_API_KEY;
    expect(h.connections.credentialStore().get("groq")).toBeUndefined();
    await h.connections.reconcile("groq");
    expect(h.catalog.get("groq")).toBeUndefined();
  });

  it("paid environment keys never resolve under FREE_ROUTES_ONLY even when enabled", async () => {
    const h = harness({ OPENAI_API_KEY: OPENAI_SECRET });
    await h.connections.setEnvironmentEnabled("openai", true);
    expect(h.connections.credentialStore().get("openai")).toBeUndefined();
    expect(h.catalog.get("openai")).toBeUndefined();
    await h.connections.setEnvironmentPolicy("ALL_ENABLED_BYOK_ROUTES");
    expect(h.connections.credentialStore().get("openai")).toBe(OPENAI_SECRET);
    expect(h.catalog.get("openai")).toBeDefined();
    await h.connections.setEnvironmentPolicy("OFF");
    expect(h.connections.credentialStore().get("openai")).toBeUndefined();
  });

  it("migrates legacy implicit env providers to enabled once, leaving new providers disabled", () => {
    const h = harness({ OPENROUTER_API_KEY: OR_SECRET, GROQ_API_KEY: GROQ_SECRET });
    expect(h.connections.migrateEnvironmentPreferences()).toBe(true);
    expect(h.connections.envSettings().preferences.openrouter?.enabled).toBe(true);
    expect(h.connections.envSettings().preferences.groq).toBeUndefined();
    expect(h.connections.credentialSourceOf("openrouter")).toBe("ENVIRONMENT");
    expect(h.connections.migrateEnvironmentPreferences()).toBe(false);
  });

  it("explicit secure connection takes precedence over an enabled environment credential", async () => {
    const h = harness({ GROQ_API_KEY: GROQ_SECRET });
    await h.connections.setEnvironmentEnabled("groq", true);
    h.secrets.set("groq", "gsk_manual_secret_0123456789abcdef");
    expect(h.connections.credentialStore().get("groq")).toBe("gsk_manual_secret_0123456789abcdef");
    expect(h.connections.credentialSourceOf("groq")).toBe("SECURE_STORAGE");
  });
});

describe("ProviderConnections — ZCode-style connect", () => {
  const groqModels: ProviderModel[] = [
    { modelId: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B", contextWindow: 131072, capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true }, isFree: false, freeStatus: "unknown" },
    { modelId: "whisper-large-v3", displayName: "Whisper", capabilities: { text: false, coding: false, toolCalling: false, vision: false, structuredOutput: false, longContext: false }, isFree: false, freeStatus: "unknown" },
  ];

  it("validate returns the classified catalog without persisting anything", async () => {
    const h = harness({}, () => groqModels);
    const result = await h.connections.validate("groq", { apiKey: "gsk_typed_once_0123456789abcdef" });
    expect(result.ok).toBe(true);
    expect(result.models?.map((m) => m.modelId)).toEqual(["openai/gpt-oss-120b"]);
    expect(result.models?.[0]?.canonicalId).toBe("openai/gpt-oss-120b");
    expect(result.models?.[0]?.free).toBe(true);
    expect(h.secrets.size).toBe(0);
    expect(h.catalog.get("groq")).toBeUndefined();
  });

  it("connect stores encrypted-at-rest fields, registers the adapter, discovers, and disconnect reverses it", async () => {
    const h = harness({}, () => groqModels);
    const result = await h.connections.connect("groq", { apiKey: "gsk_typed_once_0123456789abcdef" });
    expect(result.ok).toBe(true);
    expect(h.secrets.get("groq")).toBe("gsk_typed_once_0123456789abcdef");
    expect(h.catalog.get("groq")).toBeDefined();
    expect(h.discovered).toContain("groq");
    expect(h.connections.listConnections().find((c) => c.providerId === "groq")?.credentialSource).toBe("MANUAL_BYOK");
    await h.connections.disconnect("groq");
    expect(h.secrets.get("groq")).toBeUndefined();
    expect(h.catalog.get("groq")).toBeUndefined();
  });

  it("rejects malformed input and never stores it", async () => {
    const h = harness({}, () => groqModels);
    expect((await h.connections.connect("groq", {})).ok).toBe(false);
    expect((await h.connections.connect("groq", { apiKey: "with\nnewline" })).ok).toBe(false);
    expect((await h.connections.connect("groq", { apiKey: "x".repeat(600) })).ok).toBe(false);
    expect(h.secrets.size).toBe(0);
  });

  it("multi-field providers (Cloudflare) require every non-optional field", async () => {
    const h = harness({});
    const missing = await h.connections.validate("cloudflare-workers-ai", { apiKey: "cf-token" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Account ID/);
  });

  it("first-run offer prefers detected env credential, then OAuth, and reports ready when routes exist", () => {
    const withEnv = harness({ GROQ_API_KEY: GROQ_SECRET });
    expect(withEnv.connections.firstRunOffer()).toMatchObject({ kind: "environment", providerId: "groq", variable: "GROQ_API_KEY" });
    const empty = harness({});
    expect(empty.connections.firstRunOffer()).toMatchObject({ kind: "oauth", providerId: "openrouter" });
  });

  it("scopes the Ollama user-connected credential and exposes only sanitized Free metadata", async () => {
    const h = harness({}, () => [{ modelId: "gpt-oss:120b", displayName: "GPT-OSS 120B", capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true }, isFree: false, freeStatus: "unknown" }]);
    const secret = "ollama_user_key_0123456789abcdef";
    const result = await h.connections.connect("ollama-cloud", { apiKey: secret });
    expect(result.ok).toBe(true);
    expect(h.secrets.get(`ollama-cloud:user:${hashUserAccountIdentity("user-a")}`)).toBe(secret);
    expect(h.secrets.get("ollama-cloud")).toBeUndefined();
    expect(h.connections.listConnections().find((c) => c.providerId === "ollama-cloud")?.credentialSource).toBe("USER_CONNECTED_FREE_API_KEY");
    const serialized = JSON.stringify(h.connections.listConnections());
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("USER_CONNECTED_FREE");
    await h.connections.disconnect("ollama-cloud");
    expect(h.secrets.size).toBe(0);
  });

  it("enforces the Ollama rollout flag in the trusted connection authority", async () => {
    const h = harness({}, undefined, false);
    await expect(h.connections.validate("ollama-cloud", { apiKey: "ollama_user_key_0123456789abcdef" })).resolves.toMatchObject({ ok: false });
    await expect(h.connections.connect("ollama-cloud", { apiKey: "ollama_user_key_0123456789abcdef" })).resolves.toMatchObject({ ok: false });
    expect(h.secrets.size).toBe(0);
  });
});
