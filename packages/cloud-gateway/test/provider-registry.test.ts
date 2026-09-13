import { describe, it, expect } from "vitest";
import type { ProviderAdapter, ProviderModel, StreamEvent, ChatRequest } from "@codeforge/providers";
import { ProviderError } from "@codeforge/providers";
import { CloudFirewallManager, CloudProviderRegistry, resolveCloudProviderCredentials, MapCredentialStore, MANAGED_FREE_INVENTORY, isManagedFreeRoute } from "../src/index.js";

interface FakeAdapterConfig {
  providerId: string;
  models?: ProviderModel[];
  listError?: unknown;
  /** Whether streamChat (the allowance probe) succeeds. */
  probeOk?: boolean;
  probeError?: unknown;
}

function model(modelId: string, isFree: boolean, extra: Partial<ProviderModel> = {}): ProviderModel {
  return {
    modelId,
    displayName: extra.displayName ?? modelId,
    contextWindow: extra.contextWindow ?? 128000,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    isFree,
    freeStatus: isFree ? "verified_free" : "paid",
    ...extra,
  };
}

class FakeAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly isTestProvider = false;
  private cfg: FakeAdapterConfig;
  constructor(cfg: FakeAdapterConfig) {
    this.providerId = cfg.providerId;
    this.cfg = cfg;
  }
  setConfig(cfg: Partial<FakeAdapterConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
  }
  async listModels(): Promise<ProviderModel[]> {
    if (this.cfg.listError) throw this.cfg.listError;
    return this.cfg.models ?? [];
  }
  async *streamChat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.cfg.probeError) throw this.cfg.probeError;
    if (this.cfg.probeOk === false) return;
    yield { type: "text_delta", delta: "ok" };
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: "finish", finishReason: "stop" };
  }
  async chat() {
    return { id: "1", model: "m", choices: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
  async healthCheck() {
    return { status: "available" as const };
  }
}

function makeRegistry(adapters: Record<string, FakeAdapter>, extra: { now?: () => Date } = {}) {
  const firewallManager = new CloudFirewallManager();
  const store = new MapCredentialStore();
  for (const id of Object.keys(adapters)) store.set(id, "sk-fake");
  store.set("cloudflare-account-id", "acct-fake");
  const registry = new CloudProviderRegistry({
    firewallManager,
    credentialStore: store,
    providerIds: Object.keys(adapters),
    adapterFactory: (id) => adapters[id],
    now: extra.now,
    refreshTtlMs: 60_000,
  });
  return { firewallManager, registry };
}

describe("CloudProviderRegistry — real capacity discovery", () => {
  it("uses an exact reviewed model allowlist and disables all provider-billed built-in tools", () => {
    expect(MANAGED_FREE_INVENTORY.map((route) => `${route.providerId}::${route.modelId}`)).toEqual([
      "zai::glm-4.7-flash",
      "groq::openai/gpt-oss-120b",
      "groq::openai/gpt-oss-20b",
      "cloudflare-workers-ai::@cf/zai-org/glm-4.7-flash",
    ]);
    expect(isManagedFreeRoute("zai", "glm-5.3")).toBe(false);
    expect(isManagedFreeRoute("groq", "llama-3.3-70b-versatile")).toBe(false);
    expect(MANAGED_FREE_INVENTORY.every((route) => route.builtInToolsFree === false)).toBe(true);
    expect(MANAGED_FREE_INVENTORY.find((route) => route.providerId === "zai")?.activation).toBe("policy_record_required");
  });

  it("never admits a dynamically discovered but unapproved provider", async () => {
    const openrouter = new FakeAdapter({
      providerId: "openrouter",
      models: [model("meta-llama/llama-3.1-8b-instruct:free", true), model("anthropic/claude", false)],
    });
    const { firewallManager, registry } = makeRegistry({ openrouter });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("not_approved");
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
  });

  it("verifies allowance-tier free via a real no-charge probe (Groq)", async () => {
    // Groq lists PAID unit prices, so no $0 model is found; the probe proves the free allowance.
    const groq = new FakeAdapter({
      providerId: "groq",
      models: [model("openai/gpt-oss-120b", false)],
      probeOk: true,
    });
    const { firewallManager, registry } = makeRegistry({ groq });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("healthy");
    expect(reports[0]?.verifiedFreeCount).toBeGreaterThan(0);
    expect(firewallManager.firewall.eligibleModels().some((m) => m.providerId === "groq")).toBe(true);
  });

  it("does NOT verify allowance free when the probe fails (no owner-sponsored access)", async () => {
    const groq = new FakeAdapter({
      providerId: "groq",
      models: [model("openai/gpt-oss-120b", false)],
      probeOk: false,
    });
    const { firewallManager, registry } = makeRegistry({ groq });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("no_free_models");
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
  });

  it("NEVER registers an unapproved provider as hosted-free capacity", async () => {
    const openai = new FakeAdapter({ providerId: "openai", models: [model("gpt-4o", false)] });
    const { firewallManager, registry } = makeRegistry({ openai });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("not_approved");
    // The adapter was never even registered into the pool.
    expect(firewallManager.providerCatalog.get("openai")).toBeUndefined();
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
  });

  it("classifies a 401 as auth_required and excludes the provider from routing (orphan oracle)", async () => {
    const groq = new FakeAdapter({
      providerId: "groq",
      listError: new ProviderError("groq error (401): invalid key", "AUTH_ERROR"),
    });
    const { firewallManager, registry } = makeRegistry({ groq });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("auth_required");
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
  });

  it("classifies a 429 as rate_limited with a cooldown", async () => {
    const groq = new FakeAdapter({
      providerId: "groq",
      listError: new ProviderError("groq error (429): rate limited", "RATE_LIMITED", true),
    });
    const { registry } = makeRegistry({ groq });
    const reports = await registry.discover();
    expect(reports[0]?.status).toBe("rate_limited");
  });

  it("marks Cloudflare misconfigured when the account id is absent", async () => {
    const cf = new FakeAdapter({ providerId: "cloudflare-workers-ai", models: [] });
    const firewallManager = new CloudFirewallManager();
    const store = new MapCredentialStore();
    store.set("cloudflare-workers-ai", "token"); // no cloudflare-account-id
    const registry = new CloudProviderRegistry({
      firewallManager,
      credentialStore: store,
      providerIds: ["cloudflare-workers-ai"],
      adapterFactory: () => cf,
    });
    const reports = await registry.discover();
    expect(reports[0]?.status).toBe("misconfigured");
  });

  it("reconciles a disappeared approved route out of the pool on refresh", async () => {
    const groq = new FakeAdapter({
      providerId: "groq",
      models: [model("openai/gpt-oss-120b", false)],
    });
    const { firewallManager, registry } = makeRegistry({ groq });
    await registry.discover({ force: true });
    expect(firewallManager.firewall.eligibleModels().map((m) => m.modelId)).toContain("openai/gpt-oss-120b");

    // A disappeared approved route is reconciled away; a replacement model cannot be discovered in.
    groq.setConfig({ models: [model("llama-3.3-70b-versatile", false)] });
    await registry.discover({ force: true });

    const eligible = firewallManager.firewall.eligibleModels().map((m) => m.modelId);
    expect(eligible).not.toContain("openai/gpt-oss-120b");
  });

  it("respects the refresh TTL and coalesces concurrent discovery", async () => {
    let listCalls = 0;
    const groq = new FakeAdapter({ providerId: "groq", models: [model("openai/gpt-oss-120b", false)] });
    const origList = groq.listModels.bind(groq);
    groq.listModels = async () => {
      listCalls++;
      return origList();
    };
    const { registry } = makeRegistry({ groq });

    await registry.discover({ force: true });
    expect(listCalls).toBe(1);
    // Within TTL, no new network call.
    await registry.discover();
    expect(listCalls).toBe(1);
    // Concurrent forced calls coalesce into one in-flight pass.
    await Promise.all([registry.discover({ force: true }), registry.discover({ force: true })]);
    expect(listCalls).toBe(2);
  });
});

describe("resolveCloudProviderCredentials", () => {
  it("resolves provider keys honoring env aliases and Cloudflare's split account/token", () => {
    const env = {
      CODEFORGE_ZAI_API_KEY: "zai-key",
      CODEFORGE_GROQ_API_KEY: "g-key",
      CODEFORGE_GROQ_FREE_PLAN_ONLY: "true",
      CODEFORGE_CLOUDFLARE_ACCOUNT_ID: "acct",
      CODEFORGE_CLOUDFLARE_API_TOKEN: "cf-token",
      CODEFORGE_CLOUDFLARE_FREE_PLAN_ONLY: "true",
    };
    const { store, providerIds } = resolveCloudProviderCredentials(env);
    expect(providerIds.sort()).toEqual(["cloudflare-workers-ai", "groq"]);
    expect(store.get("zai")).toBeUndefined();
    expect(store.get("groq")).toBe("g-key");
    expect(store.get("cloudflare-workers-ai")).toBe("cf-token");
    expect(store.get("cloudflare-account-id")).toBe("acct");
  });

  it("omits Cloudflare when only the token (not the account id) is present", () => {
    const { providerIds } = resolveCloudProviderCredentials({ CODEFORGE_CLOUDFLARE_API_TOKEN: "cf-token" });
    expect(providerIds).not.toContain("cloudflare-workers-ai");
  });

  it("returns no providers for an empty environment", () => {
    const { providerIds } = resolveCloudProviderCredentials({});
    expect(providerIds).toHaveLength(0);
  });
});
