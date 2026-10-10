import { describe, expect, it, vi } from "vitest";
import { ForgeZero, freeRouteExclusionReason, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createBlockRunFreeAdapter, createMockProvider, type ChatRequest, type ProviderAdapter, type StreamEvent } from "@codeforge/providers";
import { createEightBitRouteHealthAuthority, InMemoryQualificationPersistence, REVIEWER_PROTOCOL, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { FreeCloudService } from "../src/free-cloud-service.js";
import { NormalizedModelRegistry } from "../src/registry.js";
import { supplyClassFor } from "../src/free-cloud-registry.js";
import { PROVIDER_DEFINITIONS } from "../src/provider-definitions.js";
import { reverifyBlockRunPolicy } from "../src/blockrun-policy-reverification.js";

const MODEL = "nvidia/llama-3.2-11b-vision";
const NOW = new Date();
function record(providerId: string): FreeModelRecord {
  return {
    providerId, modelId: MODEL, displayName: MODEL, tier: "free", freeStatus: "verified_free", freeStatusVerifiedAt: NOW.toISOString(),
    accessClass: "FREE_ROUTED", privacyClass: "permissive", isRemote: true, isCloudHosted: true,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false, paidFallbackDisabled: true, source: "test-free-catalog", freeTierVerifiedAt: NOW.toISOString() },
    verificationSource: "test-explicit-free", health: { status: "available", lastCheckedAt: NOW.toISOString() },
  };
}
function qualification(providerId: string): ModelQualificationReceipt {
  return {
    suiteVersion: "R41_ROLE_QUALIFICATION_V3", providerId, modelId: MODEL, modelDisplayName: MODEL,
    accessClass: "FREE_ROUTED", freeStatus: "verified_free", startedAt: NOW.toISOString(), completedAt: NOW.toISOString(), totalLatencyMs: 10,
    qualificationState: "QUALIFIED", hardFailureRoles: [],
    roleResults: { CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], overallScore: 1, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() } },
  };
}
function policy(provider: string) {
  return { sourceDocumentation: `https://${provider}.example/docs`, termsEvidence: `https://${provider}.example/terms`, priceEvidence: `https://${provider}.example/free`, privacyEvidence: `https://${provider}.example/privacy`, verifiedAt: NOW.toISOString(), recheckAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(), qualificationAt: NOW.toISOString() };
}

describe("BlockRun existing Free supply fabric", () => {
  it("archives identity failure without fabricating quota exhaustion or cooling healthy siblings", async () => {
    const providerId = "blockrun-free-direct";
    const siblingId = "cohere/north-mini-code";
    const firewall = new ForgeZero();
    firewall.register(record(providerId));
    firewall.register({ ...record(providerId), modelId: siblingId, displayName: siblingId });
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId }));
    const store = new InMemoryQualificationPersistence();
    const authority = createEightBitRouteHealthAuthority();
    const definition = PROVIDER_DEFINITIONS[providerId]!;
    const service = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(),
      qualificationStore: store, routeHealth: authority, now: () => NOW, failureCooldownMs: 5_000,
      definitions: { [providerId]: { ...definition, freeAccess: { ...definition.freeAccess, maxRequestsPerMinute: 60_000 } } },
      qualificationRunner: async model => model.modelId === MODEL
        ? { ...qualification(providerId), qualificationState: "NOT_QUALIFIED", metadata: { transient: true, requests: 1,
          providerFailureClass: "MODEL_IDENTITY", providerErrorCodes: ["MODEL_SUBSTITUTED"] } }
        : { ...qualification(providerId), modelId: model.modelId },
    });
    service.setConnection({ providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
    const failure = vi.spyOn(service, "recordRouteFailure");
    const produced = await service.qualifyPending({ providerId, budget: 2 });
    expect(produced.map(receipt => receipt.modelId)).toEqual([siblingId]);
    expect(failure).toHaveBeenCalledExactlyOnceWith(providerId, MODEL, "MODEL_IDENTITY_UNAVAILABLE");
    const routes = service.snapshot().models.flatMap(model => model.routes);
    expect(routes.find(route => route.providerModelId === MODEL)).toMatchObject({ health: "COOLDOWN", cooldownUntil: NOW.getTime() + 5_000 });
    expect(routes.find(route => route.providerModelId === siblingId)?.health).toBe("HEALTHY");
    expect(service.quotaRemaining(providerId, MODEL)).toBeUndefined();
    expect(service.getReceipt(providerId, MODEL)).toBeUndefined();
    expect((await store.loadHistory(providerId, MODEL))[0]?.metadata).toMatchObject({ transient: true, providerFailureClass: "MODEL_IDENTITY" });
    expect(authority.assess(providerId, siblingId).hardExclude).toBe(false);
    expect(authority.assess("kilo-free-direct", MODEL).hardExclude).toBe(false);
  });

  it("automatically measures non-coding text candidates for Reviewer without a Coder prerequisite", async () => {
    const firewall = new ForgeZero();
    const candidate = record("blockrun-free-direct");
    candidate.capabilities.coding = false;
    firewall.register(candidate);
    const requests: ChatRequest[] = [];
    const provider: ProviderAdapter = {
      providerId: "blockrun-free-direct", isTestProvider: true,
      async listModels() { return []; },
      async chat() { throw new Error("qualification must use the production stream"); },
      async healthCheck() { return { status: "available" }; },
      async *streamChat(request: ChatRequest): AsyncIterable<StreamEvent> {
        requests.push(request);
        const input = request.messages.map((message) => message.content).join("\n");
        const buggy = /add\(\)|Record provider failures|fast path|flaky router test/.test(input)
          || input.includes("Current content:\nexport function retryDelays(maxAttempts, baseMs) { const delays = []; for (let attempt = 0; attempt <= maxAttempts;");
        yield { type: "text_delta", delta: JSON.stringify({ verdict: buggy ? "revision_required" : "pass", summary: "Independent review", findings: buggy ? [{ id: "defect", severity: "blocking", category: "correctness", message: "calc.ts multiply; catch swallow; reserve without release; weakened test assertion; retry.mjs inclusive maxAttempts boundary" }] : [] }) };
        yield { type: "finish", finishReason: "stop" };
      },
    };
    const catalog = new InMemoryProviderCatalog();
    catalog.register(provider);
    const definition = PROVIDER_DEFINITIONS[provider.providerId]!;
    const service = new FreeCloudService({ firewall, providerCatalog: catalog, registry: new NormalizedModelRegistry(), definitions: { [provider.providerId]: { ...definition, freeAccess: { ...definition.freeAccess, maxRequestsPerMinute: 60_000 } } } });
    service.setConnection({ providerId: provider.providerId, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
    const receipts = await service.qualifyPending({ providerId: provider.providerId, budget: 1 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.qualificationState).toBe("QUALIFIED");
    expect(Object.keys(receipts[0]!.roleResults)).toEqual(["REVIEWER"]);
    expect(receipts[0]?.metadata).toMatchObject({ requests: 8, roleProtocolVersions: { REVIEWER: REVIEWER_PROTOCOL.version } });
    expect(requests.every((request) => request.tools === undefined)).toBe(true);
    expect(service.productionCapacityRoutes().find((route) => route.providerId === provider.providerId)?.roles).toEqual(["REVIEWER", "VERIFIER_ASSIST"]);
  });

  it("packages the installed-client route with public-IP supply ownership", () => {
    const definition = PROVIDER_DEFINITIONS["blockrun-free-direct"]!;
    expect(definition.implemented).toBe(true);
    expect(definition.connection.fields).toHaveLength(0);
    expect(supplyClassFor(definition, { providerId: definition.id, connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok" })).toBe("PACKAGED_FREE_DIRECT");
    expect(definition.freeAccess.quota).toContain("shared across Free models");
  });

  it("requires BlockRun's own policy receipt rather than inheriting Kilo's receipt", async () => {
    const firewall = new ForgeZero();
    firewall.register(record("blockrun-free-direct"));
    const service = new FreeCloudService({ firewall, providerCatalog: new InMemoryProviderCatalog(), registry: new NormalizedModelRegistry(), qualificationStore: new InMemoryQualificationPersistence() });
    service.setConnection({ providerId: "blockrun-free-direct", connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
    await service.recordReceipt(qualification("blockrun-free-direct"));
    service.setKiloPolicyReceipt(policy("kilo"));
    const before = service.productionCapacityRoutes().find((route) => route.providerId === "blockrun-free-direct")!;
    expect(before.admissionReceipt).toBeUndefined();
    expect(freeRouteExclusionReason(before, undefined, { dataClass: "PUBLIC_CODE" })).toBe("ADMISSION_RECEIPT_MISSING");
    service.setDirectPolicyReceipt("blockrun-free-direct", policy("blockrun"));
    const route = service.productionCapacityRoutes().find((item) => item.providerId === "blockrun-free-direct")!;
    expect(route.admissionReceipt?.termsEvidence).toContain("blockrun.example");
    expect(route.quotaDomainType).toBe("PUBLIC_IP");
    expect(route.capacityScope).toBe("SOURCE_IP");
    expect(route.egressMode).toBe("CLIENT_DIRECT");
    expect(freeRouteExclusionReason(route, undefined, { dataClass: "PUBLIC_CODE" })).toBeUndefined();
    expect(freeRouteExclusionReason(route, undefined, { dataClass: "PRIVATE_CODE" })).toBe("PRIVATE_CODE_CONSENT_REQUIRED");
    service.setDirectPolicyReceipt("blockrun-free-direct", undefined);
    expect(service.productionCapacityRoutes().find((item) => item.providerId === "blockrun-free-direct")?.admissionReceipt).toBeUndefined();
  });

  it("keeps a BlockRun IP cooldown away from Kilo and other source-IP identities", async () => {
    const health = createEightBitRouteHealthAuthority();
    const service = new FreeCloudService({ firewall: new ForgeZero(), providerCatalog: new InMemoryProviderCatalog(), registry: new NormalizedModelRegistry(), routeHealth: health });
    service.setConnection({ providerId: "blockrun-free-direct", connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok", ownerUserId: "alice" });
    const adapter = createBlockRunFreeAdapter({ onResponse: service.onProviderResponse, fetchFn: (async (target: string) => target.endsWith("/models")
      ? Response.json({ data: [{ id: MODEL, billing_mode: "free", available: true, pricing: { input: 0, output: 0 }, categories: ["chat"] }] })
      : Response.json({ error: { code: "FREE_TIER_RATE_LIMITED", message: "model quota" } }, { status: 429, headers: { "retry-after": "120" } })) as typeof fetch });
    await expect(adapter.chat({ model: MODEL, messages: [{ role: "user", content: "public synthetic fixture" }] })).rejects.toMatchObject({ rateLimitScope: "provider" });
    const domain = "blockrun-free-direct:user:localconn:blockrun-free-direct";
    expect(health.assess(adapter.providerId, "cohere/north-mini-code", { quotaDomainId: domain }).hardExclude).toBe(true);
    expect(health.assess(adapter.providerId, MODEL, { quotaDomainId: "independent-egress" }).hardExclude).toBe(false);
    expect(health.assess("kilo-free-direct", "cohere/north-mini-code:free", { quotaDomainId: domain }).hardExclude).toBe(false);
  });

  it("does not renew policy evidence when authoritative terms change", async () => {
    const fetcher = (async (target: string) => { const response = new Response("<main>changed terms</main>"); Object.defineProperty(response, "url", { value: target }); return response; }) as typeof fetch;
    expect(await reverifyBlockRunPolicy(NOW.toISOString(), { fetcher })).toMatchObject({ status: "CHANGED", source: "terms" });
  });

  it("records the safe network error code when BlockRun policy cannot be fetched", async () => {
    const fetcher = (async () => { throw Object.assign(new Error("offline"), { code: "ENOTFOUND" }); }) as typeof fetch;
    expect(await reverifyBlockRunPolicy(NOW.toISOString(), { fetcher })).toMatchObject({
      status: "UNAVAILABLE", source: "terms", unavailableReason: "FETCH_FAILED", failureCode: "ENOTFOUND",
    });
  });

  it("rejects oversized BlockRun policy responses before reading the body", async () => {
    const fetcher = (async (target: string) => {
      const response = new Response("<main>terms</main>", { headers: { "content-length": "1000001" } });
      Object.defineProperty(response, "url", { value: target });
      return response;
    }) as typeof fetch;
    expect(await reverifyBlockRunPolicy(NOW.toISOString(), { fetcher })).toMatchObject({
      status: "UNAVAILABLE", source: "terms", unavailableReason: "BODY_TOO_LARGE",
    });
  });
});
