import { describe, expect, it } from "vitest";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, type ProviderAdapter, type ChatRequest, type ChatResponse, type ProviderHealthResponse, type ProviderModel, type StreamEvent } from "@codeforge/providers";
import { InMemoryQualificationPersistence } from "@codeforge/eight-bit";
import { FreeCloudService, NormalizedModelRegistry, type ModelQualificationReceipt } from "../src/index.js";

/**
 * R52 Phase Q — stale qualification receipts reopen measurement, never quarantine.
 *
 * A receipt older than 30 days (or written by an unreadable suite version) is stale
 * evidence: the route must fail CODEFORGE_QUALIFIED, re-enter pendingQualification,
 * and become eligible again only through a fresh bounded qualification cycle.
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
  };
}

function qualifiedReceipt(providerId: string, modelId: string, completedAt: string, suiteVersion = "R41_ROLE_QUALIFICATION_V3"): ModelQualificationReceipt {
  const role = { role: "CODER" as const, status: "QUALIFIED" as const, testCases: [], hardFailures: [], overallScore: 1, startedAt: completedAt, completedAt };
  return {
    suiteVersion,
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_NATIVE",
    freeStatus: "verified_free",
    roleResults: { CODER: role },
    startedAt: completedAt,
    completedAt,
    totalLatencyMs: 10,
    qualificationState: "QUALIFIED",
    hardFailureRoles: [],
  };
}

function testAdapter(providerId: string): ProviderAdapter {
  return {
    providerId,
    isTestProvider: true,
    async listModels(): Promise<ProviderModel[]> { return []; },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      return { id: "c1", model: req.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finishReason: "stop" }] };
    },
    async *streamChat(): AsyncIterable<StreamEvent> {},
    async healthCheck(): Promise<ProviderHealthResponse> { return { status: "available" }; },
  };
}

function service(store: InMemoryQualificationPersistence, catalog: InMemoryProviderCatalog, runner?: (model: { providerId: string; modelId: string }) => Promise<ModelQualificationReceipt>) {
  const fw = new ForgeZero();
  fw.register(freeRecord("groq", "model-a"));
  const svc = new FreeCloudService({
    firewall: fw,
    providerCatalog: catalog,
    registry: new NormalizedModelRegistry(),
    qualificationStore: store,
    qualificationCycleIntervalMs: 0,
    qualificationRunner: runner ?? (async (model) => qualifiedReceipt(model.providerId, model.modelId, NOW.toISOString())),
  });
  svc.setConnection({ providerId: "groq", connected: true, credentialSource: "SECURE_STORAGE", authState: "ok", planAttested: true });
  svc.registerManagedPool("groq", "acct-a");
  catalog.register(testAdapter("groq"));
  return svc;
}

describe("R52 Phase Q — stale receipt lifecycle", () => {
  it("a receipt older than 30 days restores as STALE, is not trusted, and requalifies on demand", async () => {
    const store = new InMemoryQualificationPersistence();
    const catalog = new InMemoryProviderCatalog();
    const stale = qualifiedReceipt("groq", "model-a", new Date(NOW.getTime() - 31 * 24 * 60 * 60_000).toISOString());
    const svc = service(store, catalog);
    await svc.recordReceipt(stale);

    const route = svc.snapshot().models.flatMap((m) => m.routes).find((r) => r.providerModelId === "model-a");
    expect(route?.qualificationState).toBe("STALE");
    expect(svc.isForgeAutoEligible("groq", "model-a")).toBe(false);
    // Stale reopens measurement — the route is pending again, not quarantined.
    expect(svc.pendingQualification().some((r) => r.providerId === "groq" && r.providerModelId === "model-a")).toBe(true);

    const produced = await svc.qualifyPending();
    expect(produced.length).toBe(1);
    expect(svc.isForgeAutoEligible("groq", "model-a")).toBe(true);
    expect(svc.snapshot().models.flatMap((m) => m.routes).find((r) => r.providerModelId === "model-a")?.qualificationState).toBe("QUALIFIED");
  });

  it("a receipt written by an unreadable suite version is stale evidence, not a hard failure", async () => {
    const store = new InMemoryQualificationPersistence();
    const catalog = new InMemoryProviderCatalog();
    const svc = service(store, catalog);
    await svc.recordReceipt(qualifiedReceipt("groq", "model-a", NOW.toISOString(), "R9_PREHISTORIC_SUITE"));

    const route = svc.snapshot().models.flatMap((m) => m.routes).find((r) => r.providerModelId === "model-a");
    expect(route?.qualificationState).toBe("STALE");
    expect(svc.isForgeAutoEligible("groq", "model-a")).toBe(false);
    expect(svc.pendingQualification().some((r) => r.providerId === "groq" && r.providerModelId === "model-a")).toBe(true);
  });

  it("a restarted service treats a restored stale receipt the same — pending, never parked or trusted", async () => {
    const store = new InMemoryQualificationPersistence();
    const boot1 = service(store, new InMemoryProviderCatalog());
    await boot1.recordReceipt(qualifiedReceipt("groq", "model-a", new Date(NOW.getTime() - 45 * 24 * 60 * 60_000).toISOString()));

    const boot2 = service(store, new InMemoryProviderCatalog());
    expect(await boot2.loadQualification()).toBe(1);
    const route = boot2.snapshot().models.flatMap((m) => m.routes).find((r) => r.providerModelId === "model-a");
    expect(route?.qualificationState).toBe("STALE");
    expect(boot2.isForgeAutoEligible("groq", "model-a")).toBe(false);
    expect(boot2.pendingQualification().some((r) => r.providerModelId === "model-a")).toBe(true);

    await boot2.qualifyPending();
    expect(boot2.isForgeAutoEligible("groq", "model-a")).toBe(true);
  });
});
