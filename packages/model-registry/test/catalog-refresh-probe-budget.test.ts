import { describe, expect, it } from "vitest";
import { ForgeZero, createGenericFreeRecord } from "@codeforge/forge-zero";
import { EightBitRouteHealthAuthority, type NormalizedObservation } from "@codeforge/eight-bit";
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
