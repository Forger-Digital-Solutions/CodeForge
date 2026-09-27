import { describe, it, expect } from "vitest";
import type { ProviderAdapter, ProviderModel, StreamEvent, ChatRequest } from "@codeforge/providers";
import { ProviderError } from "@codeforge/providers";
import { CloudFirewallManager, CloudProviderRegistry, resolveCloudProviderCredentials, MapCredentialStore } from "../src/index.js";

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

function makeRegistry(adapters: Record<string, FakeAdapter>, extra: { now?: () => Date; standardTerms?: boolean; onResponse?: (obs: import("@codeforge/providers").ProviderResponseObservation) => void } = {}) {
  const firewallManager = new CloudFirewallManager(extra.standardTerms ? undefined : {
    enterpriseOverrides: {
      openrouter: {
        providerId: "openrouter",
        status: "ENTERPRISE_AUTHORIZED",
        agreementReference: "test-only-fixture",
        allowedArchitectures: ["HOSTED_MULTI_TENANT"],
      },
    },
  });
  const store = new MapCredentialStore();
  for (const id of Object.keys(adapters)) store.set(id, "sk-fake");
  store.set("cloudflare-account-id", "acct-fake");
  const observers: Record<string, import("@codeforge/providers").ProviderResponseObserver> = {};
  const registry = new CloudProviderRegistry({
    firewallManager,
    credentialStore: store,
    providerIds: Object.keys(adapters),
    adapterFactory: (id, ctx) => {
      observers[id] = ctx.onResponse;
      return adapters[id];
    },
    onResponse: extra.onResponse,
    now: extra.now,
    refreshTtlMs: 60_000,
  });
  return { firewallManager, registry, observers };
}

describe("CloudProviderRegistry — real capacity discovery", () => {
  it("does not advertise standard-terms OpenRouter as managed multi-user capacity", async () => {
    const openrouter = new FakeAdapter({ providerId: "openrouter", models: [model("x/y:free", true)] });
    const { firewallManager, registry } = makeRegistry({ openrouter }, { standardTerms: true });
    const [report] = await registry.discover();
    expect(report?.status).toBe("policy_blocked");
    expect(report?.error).toBe("OPENROUTER_ENTERPRISE_AGREEMENT_REQUIRED");
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
    expect(firewallManager.providerCatalog.get("openrouter")).toBeUndefined();
  });

  it("discovers zero-unit free models from a gateway provider (OpenRouter :free)", async () => {
    const openrouter = new FakeAdapter({
      providerId: "openrouter",
      models: [model("meta-llama/llama-3.1-8b-instruct:free", true), model("anthropic/claude", false)],
    });
    const { firewallManager, registry } = makeRegistry({ openrouter });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("healthy");
    expect(reports[0]?.verifiedFreeCount).toBe(1);
    const eligible = firewallManager.firewall.eligibleModels();
    expect(eligible.map((m) => m.modelId)).toContain("meta-llama/llama-3.1-8b-instruct:free");
    // The paid model is NOT eligible.
    expect(eligible.map((m) => m.modelId)).not.toContain("anthropic/claude");
  });

  it("verifies allowance-tier free via a real no-charge probe (Groq)", async () => {
    // Groq lists PAID unit prices, so no $0 model is found; the probe proves the free allowance.
    const groq = new FakeAdapter({
      providerId: "groq",
      models: [model("llama-3.1-8b-instant", false)],
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
      models: [model("llama-3.1-8b-instant", false)],
      probeOk: false,
    });
    const { firewallManager, registry } = makeRegistry({ groq });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("no_free_models");
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
  });

  it("NEVER registers a paid-only provider as hosted-free capacity (OpenAI)", async () => {
    const openai = new FakeAdapter({ providerId: "openai", models: [model("gpt-4o", false)] });
    const { firewallManager, registry } = makeRegistry({ openai });
    const reports = await registry.discover();

    expect(reports[0]?.status).toBe("skipped_paid_only");
    // The adapter was never even registered into the pool.
    expect(firewallManager.providerCatalog.get("openai")).toBeUndefined();
    expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
  });

  it("classifies a 401 as auth_required and excludes the provider from routing (orphan oracle)", async () => {
    const openrouter = new FakeAdapter({
      providerId: "openrouter",
      listError: new ProviderError("openrouter error (401): invalid key", "AUTH_ERROR"),
    });
    const { firewallManager, registry } = makeRegistry({ openrouter });
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

  it("owner-spend firewall: a model that flips free→paid is reconciled out of the pool on refresh", async () => {
    const openrouter = new FakeAdapter({
      providerId: "openrouter",
      models: [model("x/y:free", true)],
    });
    const { firewallManager, registry } = makeRegistry({ openrouter });
    await registry.discover({ force: true });
    expect(firewallManager.firewall.eligibleModels().map((m) => m.modelId)).toContain("x/y:free");

    // Provider now lists the same model as PAID (pricing changed upstream).
    openrouter.setConfig({ models: [model("x/y:free", false)] });
    await registry.discover({ force: true });

    const eligible = firewallManager.firewall.eligibleModels().map((m) => m.modelId);
    expect(eligible).not.toContain("x/y:free");
  });

  // R47 §12: every adapter the registry builds carries an observer that updates the
  // gateway's authoritative health plane — even through the adapterFactory seam.
  describe("provider response observation (R47 §11/§12)", () => {
    const obs = (status: number, headers: Array<[string, string]> = []) => ({
      providerId: "groq",
      modelId: "llama-3.1-8b-instant",
      accountId: "managed-primary",
      status,
      headers,
      observedAt: Date.now(),
    });

    it("marks the provider auth_required when an in-flight request returns 401", async () => {
      const groq = new FakeAdapter({ providerId: "groq", models: [model("llama-3.1-8b-instant", false)], probeOk: true });
      const { firewallManager, registry, observers } = makeRegistry({ groq });
      await registry.discover();
      expect(firewallManager.firewall.eligibleModels().length).toBeGreaterThan(0);

      observers.groq!(obs(401));

      expect(firewallManager.firewall.eligibleModels()).toHaveLength(0);
      expect(
        firewallManager.firewall.allModels().find((m) => m.providerId === "groq")?.health?.status,
      ).toBe("auth_required");
    });

    it("marks only the observed model rate_limited on 429 — siblings stay eligible", async () => {
      const groq = new FakeAdapter({
        providerId: "groq",
        models: [model("llama-3.1-8b-instant", false), model("llama-3.3-70b-versatile", false)],
        probeOk: true,
      });
      const { firewallManager, registry, observers } = makeRegistry({ groq });
      await registry.discover();

      const before = Date.now();
      observers.groq!(obs(429, [["retry-after", "120"]]));

      const limited = firewallManager.firewall.allModels().find((m) => m.modelId === "llama-3.1-8b-instant");
      const sibling = firewallManager.firewall.allModels().find((m) => m.modelId === "llama-3.3-70b-versatile");
      expect(limited?.health?.status).toBe("rate_limited");
      expect(limited?.health?.retryAfter).toBeGreaterThanOrEqual(before + 120_000);
      expect(sibling?.health?.status ?? "available").not.toBe("rate_limited");
      expect(firewallManager.firewall.eligibleModels().map((m) => m.modelId)).toContain("llama-3.3-70b-versatile");
      expect(firewallManager.firewall.eligibleModels().map((m) => m.modelId)).not.toContain("llama-3.1-8b-instant");
    });

    it("falls back to provider-wide marking when the adapter cannot name the model", async () => {
      const groq = new FakeAdapter({ providerId: "groq", models: [model("llama-3.1-8b-instant", false), model("other", false)], probeOk: true });
      const { firewallManager, registry, observers } = makeRegistry({ groq });
      await registry.discover();

      observers.groq!({ providerId: "groq", status: 429, headers: [["retry-after", "30"]], observedAt: Date.now() });

      for (const m of firewallManager.firewall.allModels().filter((x) => x.providerId === "groq")) {
        expect(m.health?.status).toBe("rate_limited");
      }
    });

    it("does not flap provider health on a successful or 5xx observation", async () => {
      const groq = new FakeAdapter({ providerId: "groq", models: [model("llama-3.1-8b-instant", false)], probeOk: true });
      const { firewallManager, registry, observers } = makeRegistry({ groq });
      await registry.discover();

      observers.groq!(obs(200));
      observers.groq!(obs(503));

      const rec = firewallManager.firewall.allModels().find((m) => m.providerId === "groq");
      expect(rec?.health?.status).not.toBe("rate_limited");
      expect(rec?.health?.status).not.toBe("auth_required");
      expect(firewallManager.firewall.eligibleModels().length).toBeGreaterThan(0);
    });

    it("forwards every observation to the host sink after the health bridge", async () => {
      const received: import("@codeforge/providers").ProviderResponseObservation[] = [];
      const groq = new FakeAdapter({ providerId: "groq", models: [model("llama-3.1-8b-instant", false)], probeOk: true });
      const { registry, observers } = makeRegistry({ groq }, { onResponse: (o) => received.push(o) });
      await registry.discover();

      const o = obs(429, [["retry-after", "30"]]);
      observers.groq!(o);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ providerId: "groq", modelId: "llama-3.1-8b-instant", accountId: "managed-primary", status: 429 });
    });
  });

  it("respects the refresh TTL and coalesces concurrent discovery", async () => {
    let listCalls = 0;
    const openrouter = new FakeAdapter({ providerId: "openrouter", models: [model("x/y:free", true)] });
    const origList = openrouter.listModels.bind(openrouter);
    openrouter.listModels = async () => {
      listCalls++;
      return origList();
    };
    const { registry } = makeRegistry({ openrouter });

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
      OPENROUTER_API_KEY: "or-key",
      ZAI_API_KEY: "zai-key", // alias of ZHIPU_API_KEY
      GOOGLE_API_KEY: "g-key", // alias of GEMINI_API_KEY
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_KEY: "cf-token",
    };
    const { store, providerIds } = resolveCloudProviderCredentials(env);
    expect(providerIds.sort()).toEqual(["cloudflare-workers-ai", "google", "openrouter", "zai"]);
    expect(store.get("openrouter")).toBe("or-key");
    expect(store.get("zai")).toBe("zai-key");
    expect(store.get("google")).toBe("g-key");
    expect(store.get("cloudflare-workers-ai")).toBe("cf-token");
    expect(store.get("cloudflare-account-id")).toBe("acct");
  });

  it("omits Cloudflare when only the token (not the account id) is present", () => {
    const { providerIds } = resolveCloudProviderCredentials({ CLOUDFLARE_API_KEY: "cf-token" });
    expect(providerIds).not.toContain("cloudflare-workers-ai");
  });

  it("returns no providers for an empty environment", () => {
    const { providerIds } = resolveCloudProviderCredentials({});
    expect(providerIds).toHaveLength(0);
  });
});
