import { describe, it, expect } from "vitest";
import {
  accessBadge,
  buildModelSections,
  isHiddenModel,
  MAX_CODEFORGE_FREE_MODELS,
  resolveForgeZeroTrust,
  resolveRuntimeLabel,
  type ApiModel,
} from "../src/renderer/model-sections.js";
import type { ModelSelectorItem } from "@codeforge/ui";

const autoModels: ModelSelectorItem[] = [
  { id: "auto", displayName: "ForgeAuto/Free", tier: "free", description: "Automatic free routing" },
];

function makeModel(overrides: Partial<ApiModel>): ApiModel {
  return {
    id: "model-1",
    providerId: "codeforge-cloud",
    displayName: "Some Model",
    tier: "free",
    freeStatus: "verified_free",
    accessClass: "FREE_NATIVE",
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false },
    eligible: true,
    ...overrides,
  };
}

describe("buildModelSections", () => {
  it("always pins a Recommended section containing ForgeAuto, even with an empty catalog", () => {
    const sections = buildModelSections([], autoModels);
    expect(sections).toHaveLength(1);
    expect(sections[0].sectionLabel).toBe("RECOMMENDED");
    expect(sections[0].models[0].id).toBe("auto");
  });

  it("buckets codeforge-cloud (no-credential) models into CODEFORGE FREE, not a generic top-N cross-provider bucket", () => {
    const apiModels = [
      makeModel({ id: "free-model-1", providerId: "codeforge", displayName: "CodeForge Free Model" }),
      makeModel({ id: "openrouter::nemotron", providerId: "codeforge-cloud", displayName: "Nemotron · Included Free (Cloud)" }),
    ];
    const sections = buildModelSections(apiModels, autoModels);
    const free = sections.find((s) => s.sectionLabel === "CODEFORGE FREE");
    expect(free).toBeDefined();
    expect(free!.models.map((m) => m.id)).toEqual(["free-model-1", "openrouter::nemotron"]);
  });

  it("never surfaces the internal codeforge-auto sentinel as a second row next to ForgeAuto", () => {
    const apiModels = [makeModel({ id: "codeforge-auto", providerId: "codeforge-cloud", displayName: "CodeForge Auto · Included Free (Cloud)" })];
    const sections = buildModelSections(apiModels, autoModels);
    const allIds = sections.flatMap((s) => s.models.map((m) => m.id));
    expect(allIds).toEqual(["auto"]);
  });

  it("keeps a BYOK-connected provider's own free-of-charge model under that provider's section, not CodeForge Free", () => {
    const apiModels = [
      makeModel({ id: "or-free-1", providerId: "openrouter", displayName: "Some OpenRouter Free Model", accessClass: "FREE_NATIVE" }),
    ];
    const sections = buildModelSections(apiModels, autoModels);
    expect(sections.find((s) => s.sectionLabel === "CODEFORGE FREE")).toBeUndefined();
    const openrouter = sections.find((s) => s.sectionLabel === "OPENROUTER");
    expect(openrouter?.models.map((m) => m.id)).toEqual(["or-free-1"]);
  });

  it("caps the CodeForge Free section instead of dumping an unbounded catalog", () => {
    const apiModels = Array.from({ length: 25 }, (_, i) =>
      makeModel({ id: `cf-${i}`, providerId: "codeforge-cloud", displayName: `Model ${i}` }),
    );
    const sections = buildModelSections(apiModels, autoModels);
    const free = sections.find((s) => s.sectionLabel === "CODEFORGE FREE");
    expect(free!.models.length).toBe(MAX_CODEFORGE_FREE_MODELS);
  });

  it("buckets GEMS models into their own locked section regardless of provider id", () => {
    const apiModels = [
      makeModel({ id: "topaz", providerId: "codeforge", displayName: "Topaz", tier: "gems_paid", accessClass: "PAID", costProfile: { inputCostPerMillion: 1, outputCostPerMillion: 1, isFree: false, paidFallbackPossible: false } }),
    ];
    const sections = buildModelSections(apiModels, autoModels);
    const gems = sections.find((s) => s.sectionLabel === "GEMS");
    expect(gems?.models[0]).toMatchObject({ id: "topaz", tier: "gems_paid" });
  });

  it("keeps Paid Auto in its own section and unavailable until the server certifies it", () => {
    const paidAuto = makeModel({
      id: "gpt-5.6-luna",
      providerId: "paid-auto",
      displayName: "GPT-5.6 Luna",
      tier: "paid-auto",
      freeStatus: "paid",
      accessClass: "PAID",
      costProfile: { inputCostPerMillion: 0.2, outputCostPerMillion: 1.2, isFree: false, paidFallbackPossible: false },
      eligible: false,
      paidAutoState: "DISABLED",
    });
    const sections = buildModelSections([paidAuto], autoModels);
    expect(sections.find((s) => s.sectionLabel === "PAID AUTO")?.models[0]).toMatchObject({ id: "gpt-5.6-luna", tier: "paid-auto", available: false });
    expect(sections.find((s) => s.sectionLabel === "CODEFORGE FREE")).toBeUndefined();
  });

  it("hides the Muse Spark promotional model from every section", () => {
    const apiModels = [makeModel({ id: "muse-spark-1.2", providerId: "codeforge-cloud" })];
    const sections = buildModelSections(apiModels, autoModels);
    const allIds = sections.flatMap((s) => s.models.map((m) => m.id));
    expect(allIds).not.toContain("muse-spark-1.2");
  });

  it("orders sections Recommended, CodeForge Free, GEMS, then BYOK providers", () => {
    const apiModels = [
      makeModel({ id: "or-1", providerId: "openrouter" }),
      makeModel({ id: "topaz", providerId: "codeforge", tier: "gems_paid" }),
      makeModel({ id: "cf-1", providerId: "codeforge-cloud" }),
    ];
    const sections = buildModelSections(apiModels, autoModels);
    expect(sections.map((s) => s.sectionLabel)).toEqual(["RECOMMENDED", "CODEFORGE FREE", "GEMS", "OPENROUTER"]);
  });
});

describe("isHiddenModel", () => {
  it("matches Muse Spark spelling variants", () => {
    expect(isHiddenModel("muse-spark-1.2")).toBe(true);
    expect(isHiddenModel("MuseSpark")).toBe(true);
    expect(isHiddenModel("muse spark")).toBe(true);
    expect(isHiddenModel("nemotron-70b")).toBe(false);
  });
});

describe("accessBadge", () => {
  it("derives the badge from structured accessClass metadata, never from name matching", () => {
    expect(accessBadge(makeModel({ accessClass: "FREE_NATIVE" }))).toBe("Free");
    expect(accessBadge(makeModel({ accessClass: "FREE_ALLOWANCE" }))).toBe("Free · allowance");
    expect(
      accessBadge(makeModel({ accessClass: "PAID", costProfile: { inputCostPerMillion: 3, outputCostPerMillion: 15, isFree: false, paidFallbackPossible: false } })),
    ).toBe("Paid · $3/$15 per 1M");
  });

  it("does not call a model free merely because its name contains the word", () => {
    const namedFree = makeModel({
      id: "totally-not-free-1",
      displayName: "Totally-Not-Free-1",
      accessClass: undefined,
      costProfile: { inputCostPerMillion: 2, outputCostPerMillion: 6, isFree: false, paidFallbackPossible: false },
    });
    expect(accessBadge(namedFree)).toBe("Paid");
  });
});

describe("resolveForgeZeroTrust", () => {
  it("trusts ForgeAuto unconditionally — it only ever resolves into ForgeZero-eligible free models", () => {
    const trust = resolveForgeZeroTrust("auto", undefined, true);
    expect(trust.verifiedFree).toBe(true);
    expect(trust.label).toContain("Verified Free");
  });

  it("does not show ForgeAuto as verified when no eligible provider can execute", () => {
    const trust = resolveForgeZeroTrust("auto", undefined, false);
    expect(trust.verifiedFree).toBe(false);
    expect(trust.label).toContain("No Free Route");
  });

  it("says discovery is still running instead of claiming there is no route", () => {
    // For the first seconds after launch the live catalogs are still being verified; the badge
    // flashed "No Free Route" before flipping to "Verified Free". Neither claim is a fact yet.
    const trust = resolveForgeZeroTrust("auto", undefined, false, true);
    expect(trust.verifiedFree).toBe(false);
    expect(trust.label).toContain("Discovering");
    // Once a route is verified, discovery elsewhere no longer matters.
    expect(resolveForgeZeroTrust("auto", undefined, true, true).label).toContain("Verified Free");
  });

  it("trusts a concrete model only when its own record is independently verified free", () => {
    const verified = makeModel({ freeStatus: "verified_free", costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false } });
    expect(resolveForgeZeroTrust("model-1", verified).verifiedFree).toBe(true);
  });

  it("fails closed for a GEMS (paid) selection instead of staying green", () => {
    const gem = makeModel({ tier: "gems_paid", freeStatus: "paid", costProfile: { inputCostPerMillion: 1, outputCostPerMillion: 1, isFree: false, paidFallbackPossible: false } });
    const trust = resolveForgeZeroTrust("topaz", gem);
    expect(trust.verifiedFree).toBe(false);
    expect(trust.label).not.toContain("Verified Free");
  });

  it("fails closed for a BYOK/paid model that lacks independent free verification", () => {
    const byokPaid = makeModel({ providerId: "anthropic", freeStatus: "unknown", costProfile: undefined });
    expect(resolveForgeZeroTrust("claude-x", byokPaid).verifiedFree).toBe(false);
  });

  it("fails closed when the selection doesn't resolve to any known model", () => {
    expect(resolveForgeZeroTrust("deleted-model-id", undefined).verifiedFree).toBe(false);
  });

  it("never marks a model verified merely from a stale freeStatus without a matching zero-cost profile", () => {
    // A model that used to be free but the cost profile no longer confirms $0 must not still
    // read as verified just because the freeStatus string wasn't updated in this response.
    const drifted = makeModel({ freeStatus: "verified_free", costProfile: { inputCostPerMillion: 2, outputCostPerMillion: 2, isFree: false, paidFallbackPossible: false } });
    expect(resolveForgeZeroTrust("model-1", drifted).verifiedFree).toBe(false);
  });
});

describe("resolveRuntimeLabel", () => {
  it("labels ForgeAuto as Auto regardless of any concrete model record", () => {
    expect(resolveRuntimeLabel("auto", undefined).label).toBe("Auto");
  });

  it("labels a codeforge-cloud model as Hosted", () => {
    const model = makeModel({ providerId: "codeforge-cloud" });
    expect(resolveRuntimeLabel("codeforge-cloud-model", model).label).toBe("Hosted");
  });

  it("labels a GEMS model as Hosted even though its providerId is 'codeforge'", () => {
    const model = makeModel({ providerId: "codeforge", tier: "gems_paid" });
    expect(resolveRuntimeLabel("topaz", model).label).toBe("Hosted");
  });

  it("labels a BYOK-connected provider model as Direct (BYOK), naming the real provider", () => {
    const model = makeModel({ providerId: "openrouter" });
    const result = resolveRuntimeLabel("or-model", model);
    expect(result.label).toBe("Direct (BYOK)");
    expect(result.detail).toContain("openrouter");
  });

  it("fails closed to Unknown when the selection doesn't resolve to any known model", () => {
    expect(resolveRuntimeLabel("deleted-model", undefined).label).toBe("Unknown");
  });
});

describe("routes that cannot drive the agent loop", () => {
  const caps = (toolCalling: boolean) => ({ text: true, coding: true, toolCalling, vision: false, structuredOutput: true, longContext: true });

  it("locks a verified-free route without tool calling and says why", () => {
    // Live OpenRouter catalog: google/lyria-3-*-preview is $0 and "eligible", but it is a music
    // model with no tool calling — offering it as a coding route only wastes a request.
    const lyria = makeModel({ id: "google/lyria-3-pro-preview", providerId: "openrouter", accessClass: "FREE_ROUTED", capabilities: caps(false) });
    const sections = buildModelSections([lyria], []);
    const row = sections.flatMap((s) => s.models).find((i) => i.id === lyria.id)!;
    expect(row.available).toBe(false);
    expect(row.unavailableReason).toMatch(/tool calling/i);
    expect(row.description).toContain("No tools");
  });

  it("keeps tool-capable verified-free routes selectable", () => {
    const nemotron = makeModel({ id: "nvidia/nemotron-3-super-120b-a12b:free", providerId: "openrouter", accessClass: "FREE_ROUTED", capabilities: caps(true) });
    const row = buildModelSections([nemotron], []).flatMap((s) => s.models).find((i) => i.id === nemotron.id)!;
    expect(row.available).toBe(true);
    expect(row.description).not.toContain("No tools");
  });
});

describe("buildCanonicalModelSections (R1 canonical picker)", async () => {
  const { buildCanonicalModelSections, CANONICAL_PREFIX, resolveCanonicalTrust } = await import("../src/renderer/model-sections.js");
  const route = (providerId: string, providerModelId: string, overrides: Record<string, unknown> = {}) => ({
    routeId: `${providerId}::${providerModelId}`,
    canonicalModelId: "openai/gpt-oss-120b",
    providerId,
    providerDisplayName: providerId,
    providerModelId,
    displayName: "GPT-OSS 120B",
    freeAccessClass: "FREE_API" as const,
    authClass: "ASSISTED_KEY" as const,
    credentialSource: "SECURE_STORAGE" as const,
    connected: true,
    verifiedFree: true,
    toolSupport: true,
    structuredOutput: true,
    vision: false,
    termsStatus: "CLEARED" as const,
    health: "HEALTHY" as const,
    qualificationState: "QUALIFIED" as const,
    roles: ["PRIMARY_CODING_AGENT" as const],
    admission: { state: "FORGEAUTO_ELIGIBLE" as const, passed: [] },
    forgeAutoEligible: true,
    executable: true,
    deprecated: false,
    ...overrides,
  });
  const model = (canonicalId: string, displayName: string, readiness: "FREE_AVAILABLE" | "FREE_CONNECT_REQUIRED" | "FREE_TEMPORARILY_UNAVAILABLE" | "PAID_BYOK", routes: ReturnType<typeof route>[], extra: Record<string, unknown> = {}) => ({
    canonicalId,
    displayName,
    family: "gpt-oss",
    lab: "openai",
    routes: routes.map((r) => ({ ...r, canonicalModelId: canonicalId })),
    readiness,
    freeRouteCount: routes.length,
    healthyFreeRouteCount: routes.filter((r) => r.forgeAutoEligible).length,
    connectedFreeRouteCount: routes.filter((r) => r.connected).length,
    capabilities: { toolCalling: true, structuredOutput: true, vision: false, reasoning: false },
    contextWindow: 131072,
    qualificationState: "QUALIFIED" as const,
    roles: ["PRIMARY_CODING_AGENT" as const],
    recommendedRole: "PRIMARY_CODING_AGENT" as const,
    category: "Recommended" as const,
    forgeAutoEligible: routes.some((r) => r.forgeAutoEligible),
    freeBadge: readiness === "FREE_AVAILABLE" ? `Free · ${routes.length} of ${routes.length} routes` : readiness === "FREE_CONNECT_REQUIRED" ? "Free · Connect" : readiness === "PAID_BYOK" ? "Paid · BYOK" : "Free · Temporarily unavailable",
    ...extra,
  });
  const snapshot = (models: ReturnType<typeof model>[], healthy = 1) => ({
    generatedAt: "2026-09-12T00:00:00.000Z",
    summary: { canonicalModels: models.length, verifiedFreeModels: models.length, verifiedFreeRoutes: 3, healthyFreeRoutes: healthy, connectedProviders: 2, coolingDown: 0, primaryCodingModels: 1, paidRoutesExcluded: 0, sameModelMultiProviderModels: 1 },
    models,
    providers: [],
  });

  it("shows one row per canonical model with a route count — never one row per provider", () => {
    const gpt = model("openai/gpt-oss-120b", "GPT-OSS 120B", "FREE_AVAILABLE", [route("groq", "openai/gpt-oss-120b"), route("cerebras", "gpt-oss-120b"), route("openrouter", "openai/gpt-oss-120b:free")]);
    const sections = buildCanonicalModelSections(snapshot([gpt]) as never, [], autoModels);
    const free = sections.find((s) => s.sectionLabel === "FREE CODING")!;
    expect(free.models).toHaveLength(1);
    expect(free.models[0]!.id).toBe(`${CANONICAL_PREFIX}openai/gpt-oss-120b`);
    expect(free.models[0]!.description).toContain("Free · 3 of 3 routes");
    expect(free.models[0]!.available).toBe(true);
    expect(sections[0]!.models[0]!.available).toBe(true);
  });

  it("marks connect-required models unavailable with the connection offer, and no ForgeAuto route when nothing is healthy", () => {
    const glm = model("zai/glm-4.7-flash", "GLM-4.7 Flash", "FREE_CONNECT_REQUIRED", [route("zai", "glm-4.7-flash", { connected: false, forgeAutoEligible: false, executable: true })], {
      connectOffer: { providerId: "zai", providerDisplayName: "Z.AI", authClass: "ASSISTED_KEY", label: "Z.AI · provider key required" },
    });
    const sections = buildCanonicalModelSections(snapshot([glm], 0) as never, [], autoModels);
    expect(sections[0]!.models[0]!.available).toBe(false);
    const item = sections.find((s) => s.sectionLabel === "FREE CODING")!.models[0]!;
    expect(item.available).toBe(false);
    expect(item.unavailableReason).toContain("Z.AI · provider key required");
    expect(item.description).toContain("Free · Connect");
  });

  it("keeps paid BYOK models out of the free section and fails trust closed for them", () => {
    const paid = model("openai/gpt-5", "GPT-5", "PAID_BYOK", [route("openai", "gpt-5", { freeAccessClass: "PAID_API", verifiedFree: false, forgeAutoEligible: false })], { category: "Paid" });
    const sections = buildCanonicalModelSections(snapshot([paid], 0) as never, [], autoModels);
    expect(sections.find((s) => s.sectionLabel === "FREE CODING")).toBeUndefined();
    expect(sections.find((s) => s.sectionLabel === "BYOK / PAID")!.models[0]!.description).toBe("Paid · BYOK");
    expect(resolveCanonicalTrust(paid as never).verifiedFree).toBe(false);
    const free = model("openai/gpt-oss-120b", "GPT-OSS 120B", "FREE_AVAILABLE", [route("groq", "openai/gpt-oss-120b")]);
    expect(resolveCanonicalTrust(free as never).verifiedFree).toBe(true);
  });
});
