import { describe, expect, it } from "vitest";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ProviderAdapter, type ProviderModel } from "@codeforge/providers";
import {
  DEFAULT_ROUTE_HEALTH_POLICY,
  EightBitRouteHealthAuthority,
  EightBitRouteHealthLedger,
  type ModelQualificationReceipt,
} from "@codeforge/eight-bit";
import type { ISessionPersistence, WorkItem } from "@codeforge/sessions";
import {
  FreeCloudService,
  NormalizedModelRegistry,
  type ProviderConnectionState,
} from "../src/index.js";

const T0 = Date.parse("2026-09-22T10:00:00.000Z");

function testClock(startMs = T0) {
  let current = startMs;
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

class InMemorySessionPersistence implements ISessionPersistence {
  private readonly items = new Map<string, WorkItem>();

  async upsertWorkItem(item: WorkItem): Promise<void> {
    this.items.set(item.id, { ...item });
  }

  async insertIfAbsent(item: WorkItem): Promise<boolean> {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, { ...item });
    return true;
  }

  async getWorkItem(id: string): Promise<WorkItem | null> {
    return this.items.get(id) ?? null;
  }

  async deleteWorkItem(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async getWorkItemsByKind(kind: string): Promise<WorkItem[]> {
    return [...this.items.values()].filter((i) => i.kind === kind);
  }

  async listWorkItems(): Promise<WorkItem[]> {
    return [...this.items.values()];
  }

  async close(): Promise<void> {}
}

function createMockAdapter(
  providerId: string,
  initialModels: ProviderModel[] = [],
): ProviderAdapter & {
  setModels: (models: ProviderModel[]) => void;
  setThrow: (err: Error | null) => void;
  setChatThrow: (err: Error | null) => void;
} {
  let models = [...initialModels];
  let throwError: Error | null = null;
  let chatError: Error | null = null;
  return {
    providerId,
    displayName: providerId,
    isTestProvider: true,
    listModels: async () => {
      if (throwError) throw throwError;
      return [...models];
    },
    chat: async () => {
      if (chatError) throw chatError;
      return {
        id: "resp-1",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    setModels: (m: ProviderModel[]) => {
      models = [...m];
    },
    setThrow: (err: Error | null) => {
      throwError = err;
    },
    setChatThrow: (err: Error | null) => {
      chatError = err;
    },
  } as any;
}

function freeModelRecord(
  providerId: string,
  modelId: string,
  overrides: Partial<FreeModelRecord> = {},
): FreeModelRecord {
  const now = new Date(T0).toISOString();
  const accessClass = overrides.accessClass ?? (providerId === "openrouter" ? "FREE_ROUTED" : "FREE_ALLOWANCE");
  return {
    providerId,
    modelId,
    displayName: modelId,
    freeStatus: "verified_free",
    freeStatusVerifiedAt: now,
    tier: "free",
    contextWindow: 131072,
    capabilities: {
      text: true,
      coding: true,
      toolCalling: true,
      vision: false,
      structuredOutput: true,
      longContext: true,
    },
    costProfile: {
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      isFree: accessClass !== "FREE_ALLOWANCE",
      freeTierVerifiedAt: now,
      paidFallbackPossible: false,
      paidFallbackDisabled: true,
      source: "pricing+live-catalog",
    },
    isRemote: true,
    isCloudHosted: true,
    accessClass,
    privacyClass: "standard",
    lastVerified: now,
    verificationSource: "pricing+live-catalog",
    health: { status: "available", lastCheckedAt: now },
    ...overrides,
  };
}

function mockReceipt(providerId: string, modelId: string): ModelQualificationReceipt {
  const role = (status: "QUALIFIED" | "NOT_QUALIFIED") => ({
    role: "CODER" as const,
    status,
    testCases: [{ id: "c1", category: "tool_call" as const, passed: true, latencyMs: 50 }],
    hardFailures: [],
    overallScore: 1,
    startedAt: new Date(T0).toISOString(),
    completedAt: new Date(T0).toISOString(),
  });
  return {
    suiteVersion: "R41_ROLE_QUALIFICATION_V3",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_ALLOWANCE",
    freeStatus: "verified_free",
    roleResults: { CODER: role("QUALIFIED"), TOOL_AGENT: role("QUALIFIED") },
    startedAt: new Date(T0).toISOString(),
    completedAt: new Date(T0).toISOString(),
    totalLatencyMs: 50,
    qualificationState: "QUALIFIED",
    hardFailureRoles: [],
  };
}

describe("R27 8-Bit Production Catalog Refresh & Route Health Integration", () => {
  function setupTest(opts: { initialModels?: ProviderModel[]; initialFirewall?: FreeModelRecord[] } = {}) {
    const clock = testClock();
    const persistence = new InMemorySessionPersistence();
    const firewall = new ForgeZero();
    const authority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, clock.nowMs);
    const ledger = new EightBitRouteHealthLedger(persistence);
    ledger.attach(authority);

    const groqAdapter = createMockAdapter("groq", opts.initialModels ?? [
      {
        modelId: "openai/gpt-oss-120b",
        displayName: "openai/gpt-oss-120b",
        isFree: true,
        contextWindow: 128000,
        capabilities: { toolCalling: true, vision: false, structuredOutput: true, streaming: true },
      },
    ]);

    const providerCatalog = new InMemoryProviderCatalog();
    providerCatalog.register(groqAdapter);

    if (opts.initialFirewall) {
      for (const rec of opts.initialFirewall) {
        firewall.register(rec);
      }
    }

    const registry = new NormalizedModelRegistry();
    const svc = new FreeCloudService({
      firewall,
      providerCatalog,
      registry,
      routeHealth: authority,
      now: clock.now,
      qualificationRunner: async (model) => mockReceipt(model.providerId, model.modelId),
    });

    // Mark groq as connected with planAttested
    svc.setConnection({
      providerId: "groq",
      connected: true,
      credentialSource: "ENVIRONMENT",
      authState: "ok",
      planAttested: true,
    } as ProviderConnectionState);

    const refresh = svc.createCatalogRefresh({
      requireCredentials: false, // test environment
      persistence,
      routeHealthLedger: ledger,
      now: clock.now,
    });

    return { clock, persistence, firewall, authority, ledger, groqAdapter, providerCatalog, registry, svc, refresh };
  }

  it("scenario 1: healthy route remains healthy and eligible across refreshes (idempotency)", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { svc, refresh, authority } = setupTest({ initialFirewall: [initialRec] });

    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);

    // Initial refresh
    const r1 = await refresh.refresh();
    expect(r1.errors).toEqual([]);
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);

    // Second refresh with unchanged catalog: 0 drift events, no state thrashing
    const r2 = await refresh.refresh();
    expect(r2.driftEvents).toEqual([]);
    expect(authority.assess("groq", "openai/gpt-oss-120b").hardExclude).toBe(false);
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);
  });

  it("scenario 2: route disappears upstream → detected drift → authority MODEL_RETIRED → ForgeAuto excluded", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { svc, refresh, authority, groqAdapter, firewall } = setupTest({ initialFirewall: [initialRec] });

    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);

    // Upstream model disappears
    groqAdapter.setModels([]);

    const result = await refresh.refresh();
    expect(result.driftEvents).toHaveLength(1);
    expect(result.driftEvents[0]?.driftKind).toBe("ROUTE_DISAPPEARED");

    // Authority must show MODEL_RETIRED
    const assessment = authority.assess("groq", "openai/gpt-oss-120b");
    expect(assessment.state).toBe("MODEL_RETIRED");
    expect(assessment.hardExclude).toBe(true);
    expect(assessment.reasonCodes).toContain("MODEL_RETIRED:CATALOG_NOT_FOUND");

    // Route must be unregistered from firewall and excluded from ForgeAuto
    expect(firewall.getModel("groq", "openai/gpt-oss-120b")).toBeUndefined();
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);
  });

  it("scenario 3: temporary provider outage → degraded/temporary capacity, NOT permanent retirement", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { svc, refresh, authority, groqAdapter, clock } = setupTest({ initialFirewall: [initialRec] });

    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);

    // Upstream provider experiences outage during refresh
    groqAdapter.setThrow(new Error("503 Service Unavailable: upstream cluster timeout"));

    const result = await refresh.refresh();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("503 Service Unavailable");
    // Crucial: Groq was NOT refreshed successfully, so its model must NOT be marked as ROUTE_DISAPPEARED!
    expect(result.driftEvents).toHaveLength(0);

    // Route health enters TEMPORARY_CAPACITY (cooldown), NOT permanent retirement
    const assessment = authority.assess("groq", "openai/gpt-oss-120b");
    expect(assessment.state).toBe("TEMPORARY_CAPACITY");
    expect(assessment.hardExclude).toBe(false);
    expect(assessment.state).not.toBe("MODEL_RETIRED");

    // After temporary outage TTL expires, state clears without permanent retirement
    clock.advance(DEFAULT_ROUTE_HEALTH_POLICY.temporaryCapacityTtlMs + 1000);
    const postExpiry = authority.assess("groq", "openai/gpt-oss-120b");
    expect(postExpiry.state).not.toBe("TEMPORARY_CAPACITY");
    expect(postExpiry.state).not.toBe("MODEL_RETIRED");
  });

  it("scenario 4: 429 / quota exhaustion is preserved and never treated as route disappearance (Invariant §40)", async () => {
    // Model has temporary quota exhaustion recorded in ForgeZero
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b", {
      health: { status: "quota_exhausted", lastCheckedAt: new Date(T0).toISOString() },
    });
    const { svc, refresh, groqAdapter, firewall } = setupTest({ initialFirewall: [initialRec] });
    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));

    // Even if listModels temporarily omits it during daily quota lock
    groqAdapter.setModels([]);

    const result = await refresh.refresh();
    // Invariant (§40): detectCatalogDrift MUST ignore models with quota_exhausted!
    expect(result.driftEvents).toHaveLength(0);
    // Firewall model remains present
    expect(firewall.getModel("groq", "openai/gpt-oss-120b")).toBeDefined();
    // Receipt remains intact
    expect(svc.getReceipt("groq", "openai/gpt-oss-120b")).toBeDefined();
  });

  it("scenario 5: model genuinely renamed or replaced upstream → fail closed on old, clears retirement on new", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { svc, authority, groqAdapter, persistence, ledger, clock } = setupTest({ initialFirewall: [initialRec] });

    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));

    // Known replacement declared
    const refresh = svc.createCatalogRefresh({
      requireCredentials: false,
      persistence,
      routeHealthLedger: ledger,
      now: clock.now,
      knownReplacements: {
        "groq::openai/gpt-oss-120b": "groq::openai/gpt-oss-130b",
      },
    });

    groqAdapter.setModels([
      {
        modelId: "openai/gpt-oss-130b",
        displayName: "openai/gpt-oss-130b",
        isFree: true,
        contextWindow: 128000,
        capabilities: { toolCalling: true, vision: false, structuredOutput: true, streaming: true },
      },
    ]);

    const result = await refresh.refresh();
    expect(result.driftEvents).toHaveLength(2);
    const retiredEvent = result.driftEvents.find((e) => e.driftKind === "ROUTE_RENAMED_OR_REPLACED");
    const appearedEvent = result.driftEvents.find((e) => e.driftKind === "ROUTE_APPEARED");
    expect(retiredEvent?.modelId).toBe("openai/gpt-oss-120b");
    expect(appearedEvent?.modelId).toBe("openai/gpt-oss-130b");

    // Old model is MODEL_RETIRED and excluded
    expect(authority.assess("groq", "openai/gpt-oss-120b").hardExclude).toBe(true);
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);

    // New model has MODEL_RETIRED cleared, but is not yet qualified
    expect(authority.assess("groq", "openai/gpt-oss-130b").hardExclude).toBe(false);
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-130b")).toBe(false); // NOT yet qualified!
  });

  it("scenario 6: free terms changed to paid → fail closed, free eligibility revoked", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { svc, refresh, authority, groqAdapter, firewall } = setupTest({ initialFirewall: [initialRec] });

    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);

    // Model becomes paid upstream and allowance probe fails
    groqAdapter.setChatThrow(new Error("402 Payment Required: free allowance expired"));
    groqAdapter.setModels([
      {
        modelId: "openai/gpt-oss-120b",
        displayName: "openai/gpt-oss-120b",
        isFree: false, // NO LONGER FREE
        contextWindow: 128000,
        capabilities: { toolCalling: true, vision: false, structuredOutput: true, streaming: true },
      },
    ]);

    const result = await refresh.refresh();
    expect(result.driftEvents.some((e) => e.driftKind === "FREE_TERMS_CHANGED")).toBe(true);

    // Authority sets ACCESS_RESTRICTED (hard exclusion)
    const assessment = authority.assess("groq", "openai/gpt-oss-120b");
    expect(assessment.state).toBe("ACCESS_RESTRICTED");
    expect(assessment.hardExclude).toBe(true);

    // Unregistered from firewall and excluded from ForgeAuto
    expect(firewall.getModel("groq", "openai/gpt-oss-120b")).toBeUndefined();
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);
  });

  it("scenario 7: tool capability regression limits CODER role while preserving unaffected roles", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { refresh, authority, groqAdapter } = setupTest({ initialFirewall: [initialRec] });

    // Upstream model drops native tool calling support
    groqAdapter.setModels([
      {
        modelId: "openai/gpt-oss-120b",
        displayName: "openai/gpt-oss-120b",
        isFree: true,
        contextWindow: 128000,
        capabilities: { toolCalling: false, vision: false, structuredOutput: true, streaming: true },
      },
    ]);

    const result = await refresh.refresh();
    expect(result.driftEvents.some((e) => e.driftKind === "CAPABILITIES_CHANGED")).toBe(true);

    // CODER role assessment reflects capability limitation
    const coderAssessment = authority.assess("groq", "openai/gpt-oss-120b", { role: "CODER" });
    expect(coderAssessment.state).toBe("CAPABILITY_LIMITED");

    // PLANNER role assessment does NOT suffer the limitation
    const plannerAssessment = authority.assess("groq", "openai/gpt-oss-120b", { role: "PLANNER" });
    expect(plannerAssessment.state).not.toBe("CAPABILITY_LIMITED");
  });

  it("scenario 8: route reappears → controlled recovery requiring requalification before ForgeAuto trust", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { svc, refresh, authority, groqAdapter } = setupTest({ initialFirewall: [initialRec] });

    await svc.recordReceipt(mockReceipt("groq", "openai/gpt-oss-120b"));
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);

    // 1. Model disappears
    groqAdapter.setModels([]);
    await refresh.refresh();
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);
    expect(authority.assess("groq", "openai/gpt-oss-120b").state).toBe("MODEL_RETIRED");

    // 2. Model reappears in provider catalog
    groqAdapter.setModels([
      {
        modelId: "openai/gpt-oss-120b",
        displayName: "openai/gpt-oss-120b",
        isFree: true,
        contextWindow: 128000,
        capabilities: { toolCalling: true, vision: false, structuredOutput: true, streaming: true },
      },
    ]);
    const rReappear = await refresh.refresh();
    expect(rReappear.driftEvents.some((e) => e.driftKind === "ROUTE_APPEARED")).toBe(true);

    // Crucial: MODEL_RETIRED condition is cleared in authority
    expect(authority.assess("groq", "openai/gpt-oss-120b").hardExclude).toBe(false);

    // CRITICAL: The recovered route must NOT be immediately ForgeAuto-eligible!
    // Its receipt was invalidated, so it is in NOT_TESTED qualification state.
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);

    // It must land in pendingQualification queue
    const pending = svc.pendingQualification();
    expect(pending.some((p) => p.providerModelId === "openai/gpt-oss-120b")).toBe(true);

    // 3. Controlled qualification run
    await svc.qualifyPending({ budget: 1 });

    // Now that it has been tested and certified, ForgeAuto eligibility returns
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);
  });

  it("scenario 9: persisted route health survives authority/service reconstruction via ledger", async () => {
    const initialRec = freeModelRecord("groq", "openai/gpt-oss-120b");
    const { refresh, groqAdapter, persistence, clock } = setupTest({ initialFirewall: [initialRec] });

    // Model disappears
    groqAdapter.setModels([]);
    await refresh.refresh();

    // Verify work items exist in durable persistence
    const observations = await persistence.getWorkItemsByKind("eight_bit_route_observation");
    const snapshots = await persistence.getWorkItemsByKind("eight_bit_route_health_authority");
    expect(observations.length).toBeGreaterThanOrEqual(1);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    // Reconstruct a completely fresh authority with no prior memory
    const freshAuthority = new EightBitRouteHealthAuthority(DEFAULT_ROUTE_HEALTH_POLICY, clock.nowMs);
    expect(freshAuthority.assess("groq", "openai/gpt-oss-120b").state).toBe("UNKNOWN");

    // Hydrate fresh authority from ledger
    const freshLedger = new EightBitRouteHealthLedger(persistence);
    const hydratedCount = await freshLedger.hydrate(freshAuthority);
    expect(hydratedCount).toBeGreaterThanOrEqual(1);

    // Hydrated authority reproduces MODEL_RETIRED and hard exclusion
    const postHydration = freshAuthority.assess("groq", "openai/gpt-oss-120b");
    expect(postHydration.state).toBe("MODEL_RETIRED");
    expect(postHydration.hardExclude).toBe(true);
  });
});
