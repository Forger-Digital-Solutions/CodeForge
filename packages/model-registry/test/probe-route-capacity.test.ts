import { describe, expect, it } from "vitest";
import { ForgeZero, CapacityReservationLedger, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ChatRequest, type ChatResponse, type ProviderAdapter, type ProviderHealthResponse, type ProviderModel, type ProviderResponseObserver, type StreamEvent } from "@codeforge/providers";
import { FreeCloudService, NormalizedModelRegistry, type ProviderConnectionState } from "../src/index.js";

/**
 * R51 — demand-driven capacity measurement.
 *
 * The R33 bootstrap probes one model per provider at refresh; sibling model quota domains on
 * model-domain providers (Groq, Mistral, GitHub Models) stayed unmeasured forever — zero windows,
 * denied as exhaustion, parked with no reset and no possible recovery (admission is what generates
 * the headers, and unmeasured routes were never admitted). `probeRouteCapacity` is the bounded
 * on-demand seam that closes the deadlock: a metadata quota endpoint where offered, else one
 * `maxTokens:1` ping whose headers land through the response observer even when the call 429s.
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

function connected(providerId: string, extra: Partial<ProviderConnectionState> = {}): ProviderConnectionState {
  return { providerId, connected: true, credentialSource: "SECURE_STORAGE", authState: "ok", ...extra };
}

const QUOTA_HEADERS: Array<[string, string]> = [
  ["x-ratelimit-remaining-requests", "900"],
  ["x-ratelimit-limit-requests", "1000"],
  ["x-ratelimit-remaining-tokens", "500000"],
  ["x-ratelimit-limit-tokens", "1000000"],
  ["x-ratelimit-reset-requests", "2030-01-01T00:00:00.000Z"],
];

/**
 * A scripted adapter whose `chat` reports the supplied quota headers through the wired response
 * observer before returning or throwing — the exact contract real adapters honour (observe first,
 * throw after), so a 429 ping still measures the domain it probed.
 */
function quotaAdapter(
  providerId: string,
  models: string[],
  behavior: { emit: ProviderResponseObserver; status?: number; fail?: (callIndex: number) => boolean },
): { adapter: ProviderAdapter; chatCalls: () => number; probeCalls: () => number } {
  let calls = 0;
  let probes = 0;
  const adapter: ProviderAdapter = {
    providerId,
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> {
      return models.map((modelId) => ({
        modelId,
        displayName: modelId,
        contextWindow: 131072,
        capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true },
        isFree: true,
        freeStatus: "verified_free" as const,
      }));
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      calls++;
      behavior.emit({
        providerId,
        modelId: req.model,
        status: behavior.status ?? 200,
        headers: QUOTA_HEADERS,
        observedAt: Date.now(),
      });
      if (behavior.fail?.(calls)) {
        const err = new Error("rate limited") as Error & { status?: number };
        err.status = behavior.status ?? 429;
        throw err;
      }
      return {
        id: `probe-${calls}`,
        model: req.model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }],
      };
    },
    async probeAccountQuota(): Promise<boolean> {
      probes++;
      return false;
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> {
      return { status: "available" };
    },
  };
  return { adapter, chatCalls: () => calls, probeCalls: () => probes };
}

describe("probeRouteCapacity — demand-driven quota measurement (R51)", () => {
  it("measures an unmeasured model domain and lifts it to admittable", async () => {
    // Groq is a model-domain provider: every model is its own quota shard. The bootstrap
    // measured only model-a; model-b projects windows:[] and would previously park forever.
    const catalog = new InMemoryProviderCatalog();
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "model-a"));
    fw.register(freeRecord("groq", "model-b"));
    const svc = new FreeCloudService({ firewall: fw, providerCatalog: catalog, registry: new NormalizedModelRegistry() });
    svc.setConnection(connected("groq"));
    svc.registerManagedPool("groq", "acct-a");
    const observer = svc.managedAccountObserver("groq", "acct-a");
    const groq = quotaAdapter("groq", ["model-a", "model-b"], { emit: observer });
    catalog.register(groq.adapter);

    const before = svc.capacityRoutes().filter((r) => r.modelId === "model-b");
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.windows.length === 0)).toBe(true);

    const measured = await svc.probeRouteCapacity("groq", "model-b", { capacityPoolId: before[0]!.capacityPoolId });
    expect(measured).toBe(true);
    expect(groq.chatCalls()).toBe(1);
    expect(svc.quota.get("groq", "model-b", "acct-a")?.remainingRequests).toBe(900);

    const after = svc.capacityRoutes().find((r) => r.modelId === "model-b" && r.capacityPoolId.includes("acct-a"));
    expect(after?.windows.length).toBeGreaterThan(0);
    // Model-domain isolation: probing model-b must not fabricate model-a's domain.
    const sibling = svc.capacityRoutes().find((r) => r.modelId === "model-a" && r.capacityPoolId.includes("acct-a"));
    expect(sibling?.windows.length).toBe(0);
  });

  it("a 429 probe still measures — headers land before the adapter throws", async () => {
    const catalog = new InMemoryProviderCatalog();
    const fw = new ForgeZero();
    fw.register(freeRecord("mistral", "codestral-latest"));
    const svc = new FreeCloudService({ firewall: fw, providerCatalog: catalog, registry: new NormalizedModelRegistry() });
    svc.setConnection(connected("mistral"));
    const mistral = quotaAdapter("mistral", ["codestral-latest"], { emit: svc.onProviderResponse, status: 429, fail: () => true });
    catalog.register(mistral.adapter);

    expect(await svc.probeRouteCapacity("mistral", "codestral-latest")).toBe(true);
    expect(svc.quota.get("mistral", "codestral-latest")?.remainingRequests).toBe(900);
  });

  it("a failed probe stays fail-closed — nothing is invented, the domain stays unmeasured", async () => {
    const catalog = new InMemoryProviderCatalog();
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "model-a"));
    const svc = new FreeCloudService({ firewall: fw, providerCatalog: catalog, registry: new NormalizedModelRegistry() });
    svc.setConnection(connected("groq"));
    const silent: ProviderAdapter = {
      providerId: "groq",
      isTestProvider: true,
      async listModels(): Promise<ProviderModel[]> { return []; },
      async chat(): Promise<ChatResponse> { throw new Error("network unreachable"); },
      async *streamChat(): AsyncIterable<StreamEvent> {},
      async healthCheck(): Promise<ProviderHealthResponse> { return { status: "offline" }; },
    };
    catalog.register(silent);

    expect(await svc.probeRouteCapacity("groq", "model-a")).toBe(false);
    expect(svc.quota.get("groq", "model-a")).toBeUndefined();
    const route = svc.capacityRoutes().find((r) => r.modelId === "model-a");
    expect(route?.windows.length ?? 0).toBe(0);
  });

  it("bounds probe rate per quota domain — repeat calls inside the window do not re-probe", async () => {
    const nowMs = { v: Date.now() };
    const catalog = new InMemoryProviderCatalog();
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "model-a"));
    const svc = new FreeCloudService({ firewall: fw, providerCatalog: catalog, registry: new NormalizedModelRegistry(), now: () => new Date(nowMs.v) });
    svc.setConnection(connected("groq"));
    const silent = quotaAdapter("groq", ["model-a"], {
      emit: () => {},
      fail: () => true,
    });
    catalog.register(silent.adapter);

    expect(await svc.probeRouteCapacity("groq", "model-a")).toBe(false);
    expect(await svc.probeRouteCapacity("groq", "model-a")).toBe(false);
    expect(silent.chatCalls()).toBe(1);
    nowMs.v += 61_000;
    expect(await svc.probeRouteCapacity("groq", "model-a")).toBe(false);
    expect(silent.chatCalls()).toBe(2);
  });

  it("prefers a metadata quota endpoint over an inference ping when the adapter offers one", async () => {
    const catalog = new InMemoryProviderCatalog();
    const fw = new ForgeZero();
    fw.register(freeRecord("openrouter", "testfree/alpha:free"));
    const svc = new FreeCloudService({ firewall: fw, providerCatalog: catalog, registry: new NormalizedModelRegistry() });
    svc.setConnection(connected("openrouter"));
    svc.registerManagedPool("openrouter", "acct-or");
    const observer = svc.managedAccountObserver("openrouter", "acct-or");
    let calls = 0;
    const adapter: ProviderAdapter = {
      providerId: "openrouter",
      isTestProvider: true,
      async listModels(): Promise<ProviderModel[]> { return []; },
      async chat(): Promise<ChatResponse> { calls++; throw new Error("should not be called"); },
      async probeAccountQuota(): Promise<boolean> {
        observer({ providerId: "openrouter", modelId: undefined, status: 200, headers: QUOTA_HEADERS, observedAt: Date.now() });
        return true;
      },
      async *streamChat(): AsyncIterable<StreamEvent> {},
      async healthCheck(): Promise<ProviderHealthResponse> { return { status: "available" }; },
    };
    catalog.register(adapter);

    expect(await svc.probeRouteCapacity("openrouter", "testfree/alpha:free", { capacityPoolId: "managed:openrouter:acct-or" })).toBe(true);
    expect(calls).toBe(0);
    expect(svc.quota.hasProviderScoped("openrouter", "acct-or")).toBe(true);
  });

  it("the full seam: unmeasured denial → demand probe → admission — the R51 deadlock is closed", async () => {
    const catalog = new InMemoryProviderCatalog();
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "model-b"));
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      qualificationCycleIntervalMs: 0,
      qualificationRunner: async (model) => ({
        suiteVersion: "R41_ROLE_QUALIFICATION_V3",
        providerId: model.providerId,
        modelId: model.modelId,
        modelDisplayName: model.modelId,
        accessClass: "FREE_NATIVE",
        freeStatus: "verified_free",
        roleResults: {
          CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], overallScore: 1, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() },
        },
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        totalLatencyMs: 10,
        qualificationState: "QUALIFIED",
        hardFailureRoles: [],
      }),
    });
    svc.setConnection(connected("groq", { planAttested: true }));
    svc.registerManagedPool("groq", "acct-a");
    const observer = svc.managedAccountObserver("groq", "acct-a");
    const groq = quotaAdapter("groq", ["model-b"], { emit: observer });
    catalog.register(groq.adapter);
    await svc.qualifyPending({ budget: 1 });

    const ledger = new CapacityReservationLedger({ routes: [] });
    const request = () => ({
      reservationId: "r1",
      userId: "u",
      routeIds: [] as string[],
      role: "coder",
      taskKind: "normal",
      requests: 1,
      inputTokens: 4_000,
      outputTokens: 1_000,
      isNewUser: false,
      priority: "normal" as const,
      createdAt: NOW.toISOString(),
      leaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    const project = () => svc.capacityRoutes().filter((r) => r.capacityPoolId.includes("acct-a")).map((r) => ({ ...r, roles: ["coder"] }));

    ledger.updateRoutes(project(), svc.capacityPools());
    const denied = ledger.reserve({ ...request(), routeIds: project().map((r) => r.routeId) });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe("CAPACITY_UNMEASURED");
    expect(denied.nextAvailableAt).toBeUndefined();

    await svc.probeRouteCapacity("groq", "model-b", { capacityPoolId: project()[0]!.capacityPoolId });

    ledger.updateRoutes(project(), svc.capacityPools());
    const admitted = ledger.reserve({ ...request(), routeIds: project().map((r) => r.routeId) });
    expect(admitted.admitted).toBe(true);
  });
});
