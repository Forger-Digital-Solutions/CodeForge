import { describe, expect, it } from "vitest";
import { ForgeZero, CapacityReservationLedger, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderModel, type ProviderHealthResponse, type ProviderResponseObserver, type StreamEvent } from "@codeforge/providers";
import { InMemoryQualificationPersistence } from "@codeforge/eight-bit";
import { FreeCloudService, NormalizedModelRegistry } from "../src/index.js";

/**
 * R52 Phase X — cold-start / restart proof.
 *
 * Qualification receipts are durable; quota evidence is deliberately volatile — a
 * restarted process cannot trust yesterday's rate-limit window, so it re-measures on
 * demand. The R51 seam must hold across the restart boundary: an unmeasured domain
 * denies honestly (never parks), one bounded probe re-measures, and admission follows.
 */

const NOW = new Date();

function freeRecord(providerId: string, modelId: string, overrides: Partial<FreeModelRecord> = {}): FreeModelRecord {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: NOW.toISOString(),
    tier: "free",
    contextWindow: 131072,
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: NOW.toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "pricing+live-catalog",
    },
    isRemote: true,
    isCloudHosted: true,
    accessClass: "FREE_NATIVE",
    privacyClass: "standard",
    lastVerified: NOW.toISOString(),
    verificationSource: "pricing+live-catalog",
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
    ...overrides,
  };
}

const QUOTA_HEADERS: Array<[string, string]> = [
  ["x-ratelimit-remaining-requests", "900"],
  ["x-ratelimit-limit-requests", "1000"],
  ["x-ratelimit-reset-requests", "2030-01-01T00:00:00.000Z"],
];

function quotaAdapter(providerId: string, emit: ProviderResponseObserver): ProviderAdapter & { calls: () => number } {
  let calls = 0;
  const adapter: ProviderAdapter = {
    providerId,
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> { return []; },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls++;
      emit({ providerId, modelId: req.model, status: 200, headers: QUOTA_HEADERS, observedAt: Date.now() });
      return { id: `call-${calls}`, model: req.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }] };
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> { return { status: "available" }; },
  };
  return Object.assign(adapter, { calls: () => calls });
}

function qualifiedReceipt(providerId: string, modelId: string) {
  return {
    suiteVersion: "R41_ROLE_QUALIFICATION_V3",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_NATIVE" as const,
    freeStatus: "verified_free" as const,
    roleResults: {
      CODER: { role: "CODER" as const, status: "QUALIFIED" as const, testCases: [], hardFailures: [], overallScore: 1, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() },
    },
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    totalLatencyMs: 10,
    qualificationState: "QUALIFIED" as const,
    hardFailureRoles: [],
  };
}

describe("R52 Phase X — cold start / process restart", () => {
  it("a restarted service with durable receipts but empty quota re-measures on demand — no self-sealing park", async () => {
    const store = new InMemoryQualificationPersistence();

    // Boot 1: qualify the route and measure its quota domain normally.
    const catalog1 = new InMemoryProviderCatalog();
    const fw1 = new ForgeZero();
    fw1.register(freeRecord("groq", "model-a"));
    const svc1 = new FreeCloudService({ firewall: fw1, providerCatalog: catalog1, registry: new NormalizedModelRegistry(), qualificationStore: store });
    svc1.setConnection({ providerId: "groq", connected: true, credentialSource: "SECURE_STORAGE", authState: "ok", planAttested: true });
    svc1.registerManagedPool("groq", "acct-a");
    const observer1 = svc1.managedAccountObserver("groq", "acct-a");
    const groq1 = quotaAdapter("groq", observer1);
    catalog1.register(groq1);
    await svc1.recordReceipt(qualifiedReceipt("groq", "model-a"));
    expect(await svc1.probeRouteCapacity("groq", "model-a", { capacityPoolId: "managed:groq:acct-a" })).toBe(true);
    expect(svc1.capacityRoutes().find((r) => r.modelId === "model-a" && r.capacityPoolId.includes("acct-a"))?.windows.length).toBeGreaterThan(0);

    // RESTART: a brand-new service instance shares only the durable receipt store —
    // quota observations are gone (correctly: stale limits are not trustworthy).
    const catalog2 = new InMemoryProviderCatalog();
    const fw2 = new ForgeZero();
    fw2.register(freeRecord("groq", "model-a"));
    const svc2 = new FreeCloudService({ firewall: fw2, providerCatalog: catalog2, registry: new NormalizedModelRegistry(), qualificationStore: store });
    svc2.setConnection({ providerId: "groq", connected: true, credentialSource: "SECURE_STORAGE", authState: "ok", planAttested: true });
    svc2.registerManagedPool("groq", "acct-a");
    const observer2 = svc2.managedAccountObserver("groq", "acct-a");
    const groq2 = quotaAdapter("groq", observer2);
    catalog2.register(groq2);
    const restored = await svc2.loadQualification();
    expect(restored).toBe(1);
    // Receipt restored — quota evidence empty. The route is honestly unmeasured, NOT exhausted.
    const postRestartRoute = svc2.capacityRoutes().find((r) => r.modelId === "model-a" && r.capacityPoolId.includes("acct-a"));
    expect(postRestartRoute?.windows.length ?? 0).toBe(0);

    const ledger = new CapacityReservationLedger({ routes: [] });
    const project = () => svc2.capacityRoutes().filter((r) => r.capacityPoolId.includes("acct-a")).map((r) => ({ ...r, roles: ["coder"] }));
    const request = () => ({
      reservationId: "restart-run", userId: "u", routeIds: project().map((r) => r.routeId),
      role: "coder", taskKind: "normal", requests: 1, inputTokens: 4_000, outputTokens: 1_000,
      isNewUser: false, priority: "normal" as const, createdAt: NOW.toISOString(),
      leaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    ledger.updateRoutes(project(), svc2.capacityPools());
    const denied = ledger.reserve(request());
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe("CAPACITY_UNMEASURED");
    expect(denied.nextAvailableAt).toBeUndefined(); // honest — never a fabricated wait

    // Demand measurement under the same managed pool closes the gap — fresh evidence.
    expect(await svc2.probeRouteCapacity("groq", "model-a", { capacityPoolId: postRestartRoute!.capacityPoolId })).toBe(true);
    expect(groq2.calls()).toBe(1);
    ledger.updateRoutes(project(), svc2.capacityPools());
    expect(ledger.reserve(request()).admitted).toBe(true);
  });
});
