import { describe, expect, it } from "vitest";
import { ForgeZero, CapacityReservationLedger, freeRouteExclusionReason, supplyClassIsZeroCash, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ProviderAdapter, type ChatRequest, type ChatResponse, type ProviderModel, type ProviderHealthResponse, type StreamEvent } from "@codeforge/providers";
import { InMemoryQualificationPersistence, type ModelQualificationReceipt } from "@codeforge/eight-bit";
import { FreeCloudService, NormalizedModelRegistry, supplyClassFor } from "../src/index.js";
import { PROVIDER_DEFINITIONS } from "../src/provider-definitions.js";

/**
 * COMMUNITY_ANONYMOUS_FREE — one global anonymous community account (AI Horde's
 * `Anonymous#0`). Never per-user supply; metered by standing parallel-generation slots
 * (provider-reported concurrency), admits only with pinned policy evidence, and is
 * public-code-only because community workers can technically see prompts.
 */

const NOW = new Date();

function freeRecord(providerId: string, modelId: string): FreeModelRecord {
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: NOW.toISOString(),
    tier: "free",
    capabilities: { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: false },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: true,
      freeTierVerifiedAt: NOW.toISOString(),
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "ai-horde:anonymous-community-catalog",
    },
    isRemote: true,
    isCloudHosted: true,
    accessClass: "FREE_ROUTED",
    privacyClass: "permissive",
    lastVerified: NOW.toISOString(),
    verificationSource: "kudos-not-purchasable",
    health: { status: "available", lastCheckedAt: NOW.toISOString() },
  };
}

function hordeAdapter(emit: (obs: { providerId: string; modelId?: string; status: number; headers: Array<[string, string]>; observedAt: number }) => void): ProviderAdapter {
  return {
    providerId: "ai-horde",
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> { return []; },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      emit({ providerId: "ai-horde", modelId: req.model, status: 200, headers: [], observedAt: Date.now() });
      return { id: "h1", model: req.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }] };
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> { return { status: "available" }; },
    async probeAccountQuota(): Promise<boolean> {
      emit({
        providerId: "ai-horde",
        status: 200,
        headers: [["x-capacity-limit-concurrency", "500"], ["x-capacity-remaining-concurrency", "498"]],
        observedAt: Date.now(),
      });
      return true;
    },
  };
}

function qualifiedReceipt(providerId: string, modelId: string): ModelQualificationReceipt {
  return {
    suiteVersion: "R41_ROLE_QUALIFICATION_V3",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_ROUTED",
    freeStatus: "verified_free",
    roleResults: {
      CODER: { role: "CODER", status: "QUALIFIED", testCases: [], hardFailures: [], overallScore: 1, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() },
    },
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    totalLatencyMs: 10,
    qualificationState: "QUALIFIED",
    hardFailureRoles: [],
  };
}

function hordeReceipt() {
  return {
    sourceDocumentation: "https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/README.md",
    termsEvidence: "https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/definitions.md",
    priceEvidence: "https://raw.githubusercontent.com/Haidra-Org/haidra-assets/main/docs/kudos.md",
    privacyEvidence: "https://raw.githubusercontent.com/Haidra-Org/AI-Horde/main/FAQ.md",
    verifiedAt: NOW.toISOString(),
    recheckAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000).toISOString(),
    qualificationAt: NOW.toISOString(),
  };
}

function service(): FreeCloudService {
  const fw = new ForgeZero();
  fw.register(freeRecord("ai-horde", "aphrodite/DeepSeek-V4.1-Flash"));
  const catalog = new InMemoryProviderCatalog();
  const svc = new FreeCloudService({ firewall: fw, providerCatalog: catalog, registry: new NormalizedModelRegistry(), qualificationStore: new InMemoryQualificationPersistence() });
  svc.setConnection({ providerId: "ai-horde", connected: true, credentialSource: "ANONYMOUS_DIRECT", supplyClass: "COMMUNITY_ANONYMOUS_FREE", authState: "ok" });
  catalog.register(hordeAdapter(svc.onProviderResponse));
  return svc;
}

describe("COMMUNITY_ANONYMOUS_FREE (AI Horde)", () => {
  it("classifies the anonymous community connection — zero-cash, never per-user", () => {
    const def = PROVIDER_DEFINITIONS["ai-horde"];
    expect(def?.implemented).toBe(true);
    expect(supplyClassFor(def, { providerId: "ai-horde", connected: true, credentialSource: "ANONYMOUS_DIRECT", authState: "ok" })).toBe("COMMUNITY_ANONYMOUS_FREE");
    expect(supplyClassIsZeroCash("COMMUNITY_ANONYMOUS_FREE")).toBe(true);
  });

  it("projects the global shared pool — GLOBAL_SHARED quota domain, CLIENT_DIRECT, public-code-only", async () => {
    const svc = service();
    await svc.recordReceipt(qualifiedReceipt("ai-horde", "aphrodite/DeepSeek-V4.1-Flash"));
    svc.setHordePolicyReceipt(hordeReceipt());
    const route = svc.capacityRoutes().find((r) => r.providerId === "ai-horde");
    expect(route).toBeDefined();
    expect(route!.supplyClass).toBe("COMMUNITY_ANONYMOUS_FREE");
    expect(route!.capacityPoolScope).toBe("SHARED_OWNER_POOL");
    expect(route!.quotaDomainType).toBe("GLOBAL_SHARED");
    expect(route!.quotaDomainId).toBe("shared:ai-horde");
    expect(route!.egressMode).toBe("CLIENT_DIRECT");
    expect(route!.marginalCostToCodeForge).toBe(0);
    expect(route!.dataPolicyProfile).toBe("PUBLIC_CODE_ONLY");
    expect(route!.capacityScope).toBe("GLOBAL");
    expect(route!.paidFallbackDisabled).toBe(true);
    expect(route!.admissionReceipt?.priceEvidence).toContain("kudos.md");
    const pool = svc.capacityPools().find((p) => p.providerId === "ai-horde");
    expect(pool?.scope).toBe("SHARED_OWNER_POOL");
    expect(pool?.poolId).toBe("shared:ai-horde");
    expect(pool?.capacityIdentity).toBe("community:ai-horde");
  });

  it("fails closed without the pinned policy receipt, and never on private code (privacy gate fires first)", async () => {
    const svc = service();
    await svc.recordReceipt(qualifiedReceipt("ai-horde", "aphrodite/DeepSeek-V4.1-Flash"));
    const unadmitted = svc.productionCapacityRoutes().find((r) => r.providerId === "ai-horde");
    expect(freeRouteExclusionReason(unadmitted!, undefined, { dataClass: "PUBLIC_CODE" })).toBe("ADMISSION_RECEIPT_MISSING");

    svc.setHordePolicyReceipt(hordeReceipt());
    const route = svc.productionCapacityRoutes().find((r) => r.providerId === "ai-horde");
    expect(freeRouteExclusionReason(route!, undefined, { dataClass: "PUBLIC_CODE" })).toBeUndefined();
    expect(freeRouteExclusionReason(route!, undefined, { dataClass: "PRIVATE_CODE" })).toBe("PRIVATE_CODE_CONSENT_REQUIRED");
  });

  it("stamps community observations on the shared pool, not a per-user domain", async () => {
    const svc = service();
    expect(await svc.probeRouteCapacity("ai-horde", "aphrodite/DeepSeek-V4.1-Flash")).toBe(true);
    const route = svc.capacityRoutes().find((r) => r.providerId === "ai-horde");
    const concurrency = route?.windows.find((w) => w.unit === "concurrency");
    expect(concurrency).toMatchObject({ limit: 500, remaining: 498, scope: "GLOBAL", authoritative: true });
    expect(route?.quotaScopeEvidence?.scope).toBe("GLOBAL");
    const pool = svc.capacityPools().find((p) => p.providerId === "ai-horde");
    expect(pool?.windows.find((w) => w.unit === "concurrency")?.remaining).toBe(498);
    expect(pool?.quotaScopeEvidence?.scope).toBe("GLOBAL");
    // Independence: a verified GLOBAL scope key — provably distinct from Kilo's SOURCE_IP group.
    expect(route?.independenceKey).toContain("ai-horde:GLOBAL:");
  });

  it("admits reservations on concurrency evidence alone — no fabricated request budget", async () => {
    const svc = service();
    await svc.recordReceipt(qualifiedReceipt("ai-horde", "aphrodite/DeepSeek-V4.1-Flash"));
    svc.setHordePolicyReceipt(hordeReceipt());
    await svc.probeRouteCapacity("ai-horde", "aphrodite/DeepSeek-V4.1-Flash");
    const project = () => svc.productionCapacityRoutes().filter((r) => r.providerId === "ai-horde").map((r) => ({ ...r, roles: ["coder"] }));
    const ledger = new CapacityReservationLedger({ routes: [] });
    ledger.updateRoutes(project(), svc.capacityPools());
    const admitted = ledger.reserve({
      reservationId: "r1", userId: "u", routeIds: project().map((r) => r.routeId),
      role: "coder", taskKind: "normal", requests: 1, inputTokens: 4_000, outputTokens: 1_000,
      isNewUser: false, priority: "normal", createdAt: NOW.toISOString(),
      leaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
      dataContext: { dataClass: "PUBLIC_CODE" },
    });
    expect(admitted.admitted).toBe(true);
    // Before the account probe lands, the route is honestly unmeasured — never admitted on nothing.
    const cold = service();
    await cold.recordReceipt(qualifiedReceipt("ai-horde", "aphrodite/DeepSeek-V4.1-Flash"));
    cold.setHordePolicyReceipt(hordeReceipt());
    const coldRoute = cold.productionCapacityRoutes().find((r) => r.providerId === "ai-horde");
    expect(coldRoute!.windows).toHaveLength(0);
    const coldLedger = new CapacityReservationLedger({ routes: [] });
    coldLedger.updateRoutes([{ ...coldRoute!, roles: ["coder"] }], cold.capacityPools());
    const denied = coldLedger.reserve({
      reservationId: "r2", userId: "u", routeIds: [coldRoute!.routeId],
      role: "coder", taskKind: "normal", requests: 1, inputTokens: 4_000, outputTokens: 1_000,
      isNewUser: false, priority: "normal", createdAt: NOW.toISOString(),
      leaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
      dataContext: { dataClass: "PUBLIC_CODE" },
    });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe("CAPACITY_UNMEASURED");
  });

  it("rejects a forged per-user or gateway claim on the community class", () => {
    const svc = service();
    const route = svc.capacityRoutes().find((r) => r.providerId === "ai-horde");
    expect(route).toBeDefined();
    const forged = { ...route!, capacityPoolScope: "PER_USER_POOL" as const };
    expect(freeRouteExclusionReason(forged, undefined, { dataClass: "PUBLIC_CODE" })).toBeDefined();
    const wrongDomain = { ...route!, quotaDomainType: "PROVIDER_ACCOUNT" as const };
    expect(freeRouteExclusionReason(wrongDomain, undefined, { dataClass: "PUBLIC_CODE" })).toBe("COMMUNITY_ROUTE_SCOPE_INVALID");
    const gateway = { ...route!, egressMode: "CODEFORGE_GATEWAY" as const };
    expect(freeRouteExclusionReason(gateway, undefined, { dataClass: "PUBLIC_CODE" })).toBe("COMMUNITY_ROUTE_SCOPE_INVALID");
  });
});

