import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { EightBitRouteHealthAuthority, type NormalizedObservation } from "@codeforge/eight-bit";
import { createFreeCloudService } from "../src/index.js";
import {
  InMemoryProviderCatalog,
  type ChatRequest,
  type ChatResponse,
  type ProviderAdapter,
  type ProviderHealthResponse,
  type ProviderModel,
  type StreamEvent,
} from "@codeforge/providers";
import {
  FreeModelCatalogRefresh,
  NormalizedModelRegistry,
  type RefreshResultDetailed,
} from "../src/index.js";

const NOW = new Date();

/** Refresh over the bundled snapshot — deterministic and offline; never touches models.dev. */
class OfflineRegistry extends NormalizedModelRegistry {
  override async refresh(): Promise<RefreshResultDetailed> {
    this.loadSnapshot();
    return { ok: true, source: "snapshot", lastUpdated: this.lastUpdated, modelCount: this.all().length };
  }
}

/**
 * An allowance provider (groq/google have `hasAllowanceFree` in PROVIDER_POLICIES) whose
 * allowance probe would be a real provider request in production — the counter is the evidence
 * that `maxAllowanceProbes` bounds the whole refresh cycle, not each provider separately.
 */
function allowanceAdapter(providerId: string, modelId: string): { adapter: ProviderAdapter; chatCalls: () => number } {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId,
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> {
      return [{
        modelId,
        displayName: modelId,
        contextWindow: 131072,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
        // Allowance providers list paid unit prices — the free tier is what the probe proves.
        isFree: false,
        freeStatus: "unknown",
      }];
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls++;
      return {
        id: `probe-${calls}`,
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }],
      };
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> {
      return { status: "available" };
    },
  };
  return { adapter, chatCalls: () => calls };
}

/** An allowance provider whose catalog listing is unsupported — the Cloudflare Workers AI
 *  shape, where `listModels` throws and the declared `allowanceModels` are the only discovery
 *  source. */
function unsupportedCatalogAdapter(providerId: string): { adapter: ProviderAdapter; chatCalls: () => number } {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId,
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> {
      throw new Error("catalog listing unsupported by this provider");
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls++;
      return {
        id: `probe-${calls}`,
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }],
      };
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> {
      return { status: "available" };
    },
  };
  return { adapter, chatCalls: () => calls };
}

function refreshWith(
  adapters: ProviderAdapter[],
  maxAllowanceProbes: number,
  opts: { firewall?: ForgeZero; routeHealth?: EightBitRouteHealthAuthority } = {},
): FreeModelCatalogRefresh {
  const providerCatalog = new InMemoryProviderCatalog();
  for (const adapter of adapters) providerCatalog.register(adapter);
  return new FreeModelCatalogRefresh({
    providerCatalog,
    registry: new OfflineRegistry(),
    firewall: opts.firewall ?? new ForgeZero(),
    routeHealth: opts.routeHealth,
    requireCredentials: false,
    maxAllowanceProbes,
    now: () => NOW,
  });
}

describe("maxAllowanceProbes is a total refresh-cycle budget", () => {
  it("budget 0 issues zero probe calls and records zero allowance evidence", async () => {
    const groq = allowanceAdapter("groq", "llama-3.3-70b-versatile");
    const google = allowanceAdapter("google", "gemini-2.5-flash");
    const result = await refreshWith([groq.adapter, google.adapter], 0).refresh();
    expect(groq.chatCalls()).toBe(0);
    expect(google.chatCalls()).toBe(0);
    expect(result.allowance.flatMap((r) => r.records)).toEqual([]);
  });

  it("budget 1 probes exactly once across both allowance providers", async () => {
    const groq = allowanceAdapter("groq", "llama-3.3-70b-versatile");
    const google = allowanceAdapter("google", "gemini-2.5-flash");
    const result = await refreshWith([groq.adapter, google.adapter], 1).refresh();
    // One shared budget: the first provider in catalog order consumed it — not one each.
    expect(groq.chatCalls() + google.chatCalls()).toBe(1);
    expect(groq.chatCalls()).toBe(1);
    expect(google.chatCalls()).toBe(0);
    expect(result.allowance.length).toBe(1);
    expect(result.allowance[0]!.records.every((r) => r.providerId === "groq")).toBe(true);
  });

  it("budget 2 lets both providers probe — the cap is the cycle total", async () => {
    const groq = allowanceAdapter("groq", "llama-3.3-70b-versatile");
    const google = allowanceAdapter("google", "gemini-2.5-flash");
    const result = await refreshWith([groq.adapter, google.adapter], 2).refresh();
    expect(groq.chatCalls()).toBe(1);
    expect(google.chatCalls()).toBe(1);
    expect(result.allowance.length).toBe(2);
  });

  it("exhausted budget on a documented-allowlist provider skips verification — it is not a provider outage", async () => {
    // Cloudflare Workers AI exposes no catalog listing; its declared allowanceModels are the
    // discovery source. An intentional zero probe budget must not mark previously-known routes
    // PROVIDER_OUTAGE — a skipped verification is evidence of nothing about provider health.
    const cloudflare = unsupportedCatalogAdapter("cloudflare-workers-ai");
    const firewall = new ForgeZero();
    firewall.register(createGenericFreeRecord({ providerId: "cloudflare-workers-ai", modelId: "@cf/openai/gpt-oss-120b" }));
    const routeHealth = new EightBitRouteHealthAuthority();
    const observations: NormalizedObservation[] = [];
    routeHealth.subscribe((observation) => { observations.push(observation); });

    const result = await refreshWith([cloudflare.adapter], 0, { firewall, routeHealth }).refresh();

    expect(cloudflare.chatCalls()).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.allowance).toEqual([]);
    expect(
      result.errors.some((e) => e.includes("cloudflare-workers-ai") && e.includes("probe budget is exhausted")),
    ).toBe(true);
    expect(observations.some((o) => o.kind === "call_failure")).toBe(false);
    expect(observations.some((o) => "reason" in o && o.reason === "PROVIDER_OUTAGE")).toBe(false);
  });
});

/** An explicit-zero provider (the OpenRouter `:free` shape): routes verify from live $0
 *  catalog pricing, never via allowance probe — so quota windows only exist after a real
 *  response's headers are observed. The bootstrap probe is what breaks that deadlock. */
function zeroUnitAdapter(providerId: string, modelId: string): { adapter: ProviderAdapter; chatCalls: () => number } {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId,
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> {
      return [{
        modelId,
        displayName: modelId,
        contextWindow: 131072,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
        isFree: true,
        freeStatus: "free",
      }];
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls++;
      return {
        id: `probe-${calls}`,
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }],
      };
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> {
      return { status: "available" };
    },
  };
  return { adapter, chatCalls: () => calls };
}

describe("quota bootstrap probe for explicit-zero supply", () => {
  const serviceFor = (providerId: string, providerCatalog: InMemoryProviderCatalog, registry: NormalizedModelRegistry) => {
    const service = createFreeCloudService({ firewall: new ForgeZero(), providerCatalog, registry });
    service.registerManagedPool(providerId, `live-acct-${providerId}`);
    return service;
  };

  it("issues exactly one probe when an explicit-zero provider's quota is unobserved", async () => {
    const providerCatalog = new InMemoryProviderCatalog();
    const openrouter = zeroUnitAdapter("openrouter", "testfree/alpha:free");
    providerCatalog.register(openrouter.adapter);
    const registry = new OfflineRegistry();
    const service = serviceFor("openrouter", providerCatalog, registry);

    const result = await new FreeModelCatalogRefresh({
      providerCatalog, registry, service, requireCredentials: false, maxAllowanceProbes: 4, now: () => NOW,
    }).refresh();

    expect(openrouter.chatCalls()).toBe(1);
    expect(result.errors.some((e) => e.includes("quota bootstrap probe observed") && e.includes("openrouter"))).toBe(true);
  });

  it("skips the probe when quota evidence is already observed for the managed account", async () => {
    const providerCatalog = new InMemoryProviderCatalog();
    const openrouter = zeroUnitAdapter("openrouter", "testfree/alpha:free");
    providerCatalog.register(openrouter.adapter);
    const registry = new OfflineRegistry();
    const service = serviceFor("openrouter", providerCatalog, registry);
    service.quota.record("openrouter", "testfree/alpha:free", {
      remainingRequests: 900,
      limitRequests: 1000,
      observedAt: NOW.toISOString(),
    }, "live-acct-openrouter");

    await new FreeModelCatalogRefresh({
      providerCatalog, registry, service, requireCredentials: false, maxAllowanceProbes: 4, now: () => NOW,
    }).refresh();

    expect(openrouter.chatCalls()).toBe(0);
  });

  it("shares the cycle budget with allowance probes — a consumed budget skips the bootstrap honestly", async () => {
    const providerCatalog = new InMemoryProviderCatalog();
    const groq = allowanceAdapter("groq", "llama-3.3-70b-versatile");
    const openrouter = zeroUnitAdapter("openrouter", "testfree/alpha:free");
    providerCatalog.register(groq.adapter);
    providerCatalog.register(openrouter.adapter);
    const registry = new OfflineRegistry();
    const service = serviceFor("openrouter", providerCatalog, registry);

    const result = await new FreeModelCatalogRefresh({
      providerCatalog, registry, service, requireCredentials: false, maxAllowanceProbes: 1, now: () => NOW,
    }).refresh();

    expect(groq.chatCalls()).toBe(1);
    expect(openrouter.chatCalls()).toBe(0);
    expect(result.errors.some((e) => e.includes("openrouter") && e.includes("quota bootstrap skipped"))).toBe(true);
  });

  it("prefers an account-quota endpoint over an inference ping when the adapter offers one", async () => {
    // OpenRouter's real shape: /key reports free_model_daily_requests; chat responses carry no
    // quota headers at all, so an inference ping could never teach the fabric anything.
    const providerCatalog = new InMemoryProviderCatalog();
    const registry = new OfflineRegistry();
    const service = serviceFor("openrouter", providerCatalog, registry);
    const observer = service.managedAccountObserver("openrouter", "live-acct-openrouter");
    let accountProbes = 0;
    let calls = 0;
    const adapter: ProviderAdapter = {
      providerId: "openrouter",
      isTestProvider: true,
      async listModels(): Promise<ProviderModel[]> {
        return [{
          modelId: "testfree/alpha:free",
          displayName: "testfree/alpha:free",
          contextWindow: 131072,
          capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
          isFree: true,
          freeStatus: "free",
        }];
      },
      async chat(req: ChatRequest): Promise<ChatResponse> {
        calls++;
        return {
          id: `probe-${calls}`,
          model: req.model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }],
        };
      },
      async probeAccountQuota(): Promise<boolean> {
        accountProbes++;
        observer({
          providerId: "openrouter",
          modelId: undefined,
          status: 200,
          headers: [
            ["x-ratelimit-remaining-requests", "900"],
            ["x-ratelimit-limit-requests", "1000"],
            ["x-ratelimit-reset-requests", "2030-01-01T00:00:00.000Z"],
          ],
          observedAt: Date.now(),
        });
        return true;
      },
      async *streamChat(): AsyncIterable<StreamEvent> {},
      async healthCheck(): Promise<ProviderHealthResponse> {
        return { status: "available" };
      },
    };
    providerCatalog.register(adapter);

    const result = await new FreeModelCatalogRefresh({
      providerCatalog, registry, service, requireCredentials: false, maxAllowanceProbes: 4, now: () => NOW,
    }).refresh();

    expect(accountProbes).toBe(1);
    expect(calls).toBe(0);
    expect(result.errors.some((e) => e.includes("quota bootstrap observed account-level free allowance"))).toBe(true);
    const quota = service.quota.get("openrouter", "testfree/alpha:free", "live-acct-openrouter");
    expect(quota?.remainingRequests).toBe(900);
  });

  it("does not probe a provider whose catalog verified no zero-unit models", async () => {
    const providerCatalog = new InMemoryProviderCatalog();
    const openrouter = zeroUnitAdapter("openrouter", "paid/only-model");
    // Overwrite the listing with a non-free model so zeroUnitResult.records is empty.
    const paidOnly: ProviderAdapter = {
      ...openrouter.adapter,
      async listModels(): Promise<ProviderModel[]> {
        return [{
          modelId: "paid/only-model",
          displayName: "paid/only-model",
          contextWindow: 131072,
          capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
          isFree: false,
          freeStatus: "paid",
        }];
      },
    };
    providerCatalog.register(paidOnly);
    const registry = new OfflineRegistry();
    const service = serviceFor("openrouter", providerCatalog, registry);

    await new FreeModelCatalogRefresh({
      providerCatalog, registry, service, requireCredentials: false, maxAllowanceProbes: 4, now: () => NOW,
    }).refresh();

    expect(openrouter.chatCalls()).toBe(0);
  });
});
