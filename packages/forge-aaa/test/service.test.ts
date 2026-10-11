import { describe, expect, it } from "vitest";
import type { ChatRequest, ProviderAdapter, ProviderCatalog } from "@codeforge/providers";
import { ForgeAaaService, type ForgeAaaLeadRoute, type ForgeAaaRouteCandidate } from "../src/index.js";

const freeRoute: ForgeAaaLeadRoute = {
  domain: "managed_free", upstreamProviderId: "groq", upstreamModelId: "free-coder",
  displayName: "Free Coder", costClass: "free", qualifiedRoles: ["LEAD", "CODER"], available: true,
};
const paidRoute: ForgeAaaLeadRoute = {
  domain: "managed_paid", upstreamProviderId: "paid-auto", upstreamModelId: "glm-5.3-flash",
  displayName: "GLM Paid", costClass: "paid", qualifiedRoles: ["LEAD", "CODER"], available: true,
};

function candidates(): ForgeAaaRouteCandidate[] {
  return [{
    modelId: "c1", providerId: "groq", providerModelId: "free-coder", domain: "managed_free",
    lifecycle: "ACTIVE", available: true, qualifiedRoles: ["CODER"], costClass: "free", privateCodeAllowed: true,
  }];
}

function catalogWith(adapters: ProviderAdapter[]): ProviderCatalog {
  const map = new Map(adapters.map((a) => [a.providerId, a]));
  return { adapters: map, register: (a) => void map.set(a.providerId, a), get: (id) => map.get(id), all: () => [...map.values()] };
}

function upstreamAdapter(providerId = "groq"): ProviderAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    providerId, isTestProvider: true, calls,
    async listModels() { return []; },
    async chat(req: ChatRequest) { calls.push(req.model); return { choices: [{ message: { role: "assistant" as const, content: "ok" }, finishReason: "stop" as const }], usage: { inputTokens: 1, outputTokens: 1 } }; },
    async *streamChat(req: ChatRequest) { calls.push(req.model); yield { type: "finish" as const, finishReason: "stop" as const }; },
    async healthCheck() { return { status: "available" as const }; },
  };
}

describe("ForgeAaaService", () => {
  it("modelViews expose the five lead policies with honest availability", () => {
    const service = new ForgeAaaService({ routes: { leadRoutes: () => [freeRoute], routeCandidates: candidates } });
    const views = service.modelViews();
    expect(views.map((v) => v.id)).toEqual(["auto", "sol-lead", "opus-lead", "dual-lead", "economy-lead"]);
    expect(views.find((v) => v.id === "auto")?.available).toBe(true);
    const sol = views.find((v) => v.id === "sol-lead");
    expect(sol?.available).toBe(false);
    expect(sol?.state).toBe("NAMED_LEAD_UNAVAILABLE");
    expect(sol?.unavailableReason).toMatch(/unverified/i);
    expect(views.find((v) => v.id === "dual-lead")?.state).toBe("DUAL_LEAD_INCOMPLETE");
  });

  it("delegates dispatch to the resolved upstream adapter — free routes re-authorize", async () => {
    const upstream = upstreamAdapter();
    const authorized: string[] = [];
    const service = new ForgeAaaService({
      routes: { leadRoutes: () => [freeRoute], routeCandidates: candidates },
      authorizeRoute: (r) => { authorized.push(`${r.providerId}/${r.modelId}`); },
    });
    const adapter = service.asProviderAdapter(() => catalogWith([upstream]));
    await adapter.chat({ model: "auto", messages: [] });
    expect(upstream.calls).toEqual(["free-coder"]);
    expect(authorized).toEqual(["groq/free-coder"]);
  });

  it("paid leads delegate through the paid-auto adapter — no new billing path", async () => {
    const upstreamPaid = upstreamAdapter("paid-auto");
    const service = new ForgeAaaService({ routes: { leadRoutes: () => [paidRoute], routeCandidates: candidates } });
    const adapter = service.asProviderAdapter(() => catalogWith([upstreamPaid]));
    const stream = adapter.streamChat({ model: "auto", messages: [] });
    for await (const _e of stream) { /* drain */ }
    expect(upstreamPaid.calls).toEqual(["glm-5.3-flash"]);
  });

  it("fails closed when no eligible lead exists", async () => {
    const service = new ForgeAaaService({ routes: { leadRoutes: () => [], routeCandidates: () => [] } });
    const adapter = service.asProviderAdapter(() => catalogWith([]));
    await expect(adapter.chat({ model: "auto", messages: [] })).rejects.toThrowError(/NO_ELIGIBLE_ROUTE|no eligible/i);
    expect(adapter.canRoute("auto")).toBe(false);
  });

  it("strips self-asserted leadIdentity unless the registry bound it", () => {
    const fakeSol: ForgeAaaLeadRoute = { ...freeRoute, upstreamModelId: "sol", leadIdentity: "sol" };
    const service = new ForgeAaaService({ routes: { leadRoutes: () => [fakeSol], routeCandidates: candidates } });
    // No registry binding → sol-lead stays unavailable even though the route claims it.
    expect(service.resolveLead("sol-lead").outcome).toBe("named_lead_unavailable");
    service.registry.register({
      id: "lead/gpt-6.1-sol", displayName: "GPT-6.1 Sol", kind: "lead_model", serves: ["lead"],
      domain: "managed_paid", engines: ["any"], maturity: "unknown",
      access: { auth: "api_key", costClass: "paid" }, license: { commercialUse: "unknown" },
      provider: { providerId: "groq", providerModelId: "sol", leadIdentity: "sol" },
      classification: "EXPERIMENTAL", statusDetail: "test",
    });
    service.registry.recordQualification({ candidateId: "lead/gpt-6.1-sol", at: new Date().toISOString(), executed: true, passed: true, operation: "provider-catalog-probe", outcome: "VERIFIED_AVAILABLE", detail: "provider reported the model id" });
    expect(service.resolveLead("sol-lead").outcome).toBe("selected");
  });

  it("persists lead policy durably", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const service = new ForgeAaaService({
      persistence: {
        getWorkItem: async (id) => store.get(id),
        upsertWorkItem: async (item) => { store.set(item.id, item); return item; },
      },
    });
    await service.savePolicy("economy-lead");
    const rehydrated = new ForgeAaaService({
      persistence: {
        getWorkItem: async (id) => store.get(id),
        upsertWorkItem: async (item) => { store.set(item.id, item); return item; },
      },
    });
    expect(await rehydrated.loadPolicy()).toBe("economy-lead");
  });

  it("specialist roster reports honest coverage", () => {
    const service = new ForgeAaaService();
    const roster = service.specialistRoster();
    expect(roster).toHaveLength(12);
    // Before any executed qualification, nothing is covered.
    expect(roster.every((r) => r.status === "uncovered")).toBe(true);
    service.registry.recordQualification({ candidateId: "tool/blender-adapter", at: new Date().toISOString(), executed: true, passed: true, operation: "probe", outcome: "INTEGRATED", detail: "ran" });
    expect(service.specialistRoster().find((r) => r.specialty === "forge-modeler")?.status).toBe("covered");
  });
});
