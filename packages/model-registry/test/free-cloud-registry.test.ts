import { describe, expect, it } from "vitest";
import { ForgeZero, type FreeModelRecord } from "@codeforge/forge-zero";
import { InMemoryProviderCatalog, createMockProvider } from "@codeforge/providers";
import type { ModelQualificationReceipt } from "@codeforge/eight-bit";
import {
  PROVIDER_DEFINITIONS,
  PROVIDER_POLICIES,
  canonicalIdentityFor,
  groupByCanonical,
  deriveAccessClass,
  getProviderPolicy,
  detectEnvironmentCredentials,
  presenceFromEnv,
  resolveEnvironmentField,
  defaultEnvironmentPreferences,
  mergeModelsDevProviderHints,
  buildFreeCloudSnapshot,
  evaluateAdmission,
  parseRouteQuota,
  supplyClassFor,
  FreeCloudService,
  NormalizedModelRegistry,
  type ProviderConnectionState,
} from "../src/index.js";

// Real clock: several cases build ForgeZero with its default clock, and verified-free status expires
// 7 days after freeStatusVerifiedAt, so a pinned date would silently expire every fixture route a
// week after it was written (the same time bomb the eight-bit fixtures had).
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
    accessClass: providerId === "openrouter" ? "FREE_ROUTED" : "FREE_NATIVE",
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

function receipt(providerId: string, modelId: string, state: ModelQualificationReceipt["qualificationState"] = "QUALIFIED"): ModelQualificationReceipt {
  const role = (status: "QUALIFIED" | "NOT_QUALIFIED") => ({ role: "CODER" as const, status, testCases: [], hardFailures: [], overallScore: status === "QUALIFIED" ? 1 : 0, startedAt: NOW.toISOString(), completedAt: NOW.toISOString() });
  return {
    suiteVersion: "test",
    providerId,
    modelId,
    modelDisplayName: modelId,
    accessClass: "FREE_NATIVE",
    freeStatus: "verified_free",
    roleResults: { CODER: role(state === "QUALIFIED" ? "QUALIFIED" : "NOT_QUALIFIED"), TOOL_AGENT: role(state === "QUALIFIED" ? "QUALIFIED" : "NOT_QUALIFIED") },
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    totalLatencyMs: 10,
    qualificationState: state,
    hardFailureRoles: [],
  };
}

describe("canonical model identity", () => {
  it("collapses the same model served by different providers into one canonical id", () => {
    const ids = [
      canonicalIdentityFor("openrouter", "openai/gpt-oss-120b:free"),
      canonicalIdentityFor("groq", "openai/gpt-oss-120b"),
      canonicalIdentityFor("cerebras", "gpt-oss-120b"),
      canonicalIdentityFor("cloudflare-workers-ai", "@cf/openai/gpt-oss-120b"),
    ].map((i) => i.canonicalId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe("openai/gpt-oss-120b");
  });

  it("normalizes GLM, Qwen, Gemma, Nemotron and Laguna spellings across hosts", () => {
    expect(canonicalIdentityFor("zai", "glm-4.7-flash").canonicalId).toBe("zai/glm-4.7-flash");
    expect(canonicalIdentityFor("cloudflare-workers-ai", "@cf/zai-org/glm-4.7-flash").canonicalId).toBe("zai/glm-4.7-flash");
    expect(canonicalIdentityFor("huggingface", "zai-org/GLM-4.7-Flash").canonicalId).toBe("zai/glm-4.7-flash");
    expect(canonicalIdentityFor("groq", "qwen/qwen3.8-27b").canonicalId).toBe("qwen/qwen3.8-27b");
    expect(canonicalIdentityFor("cerebras", "qwen-3.8-27b").canonicalId).toBe("qwen/qwen3.8-27b");
    expect(canonicalIdentityFor("openrouter", "google/gemma-4-31b-it:free").canonicalId).toBe("google/gemma-4-31b");
    expect(canonicalIdentityFor("cerebras", "gemma-4-31b").canonicalId).toBe("google/gemma-4-31b");
    expect(canonicalIdentityFor("cloudflare-workers-ai", "@cf/nvidia/nemotron-3-120b-a12b").canonicalId).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(canonicalIdentityFor("openrouter", "nvidia/nemotron-3-super-120b-a12b:free").canonicalId).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(canonicalIdentityFor("opencode", "laguna-s-2.1-free").canonicalId).toBe("poolside/laguna-s-2.1");
    expect(canonicalIdentityFor("openrouter", "poolside/laguna-s-2.1:free").freeVariant).toBe(true);
  });

  it("keeps distinct models distinct and never uses price for identity", () => {
    expect(canonicalIdentityFor("groq", "openai/gpt-oss-20b").canonicalId).not.toBe(canonicalIdentityFor("groq", "openai/gpt-oss-120b").canonicalId);
    expect(canonicalIdentityFor("openrouter", "poolside/laguna-xs-2.1:free").canonicalId).not.toBe(canonicalIdentityFor("openrouter", "poolside/laguna-s-2.1:free").canonicalId);
    const grouped = groupByCanonical([
      { providerId: "groq", modelId: "openai/gpt-oss-120b" },
      { providerId: "cerebras", modelId: "gpt-oss-120b" },
      { providerId: "groq", modelId: "openai/gpt-oss-20b" },
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get("openai/gpt-oss-120b")?.routes.length).toBe(2);
  });

  it("produces curated display names without provider duplicates", () => {
    expect(canonicalIdentityFor("groq", "openai/gpt-oss-120b").displayName).toBe("GPT-OSS 120B");
    expect(canonicalIdentityFor("openrouter", "poolside/laguna-s-2.1:free", "Laguna S 2.1 (free)").displayName).toBe("Laguna S 2.1");
  });
});

describe("provider definitions and derived policies", () => {
  it("derives the legacy policy view from definitions without losing existing semantics", () => {
    expect(getProviderPolicy("openrouter")?.authMode).toBe("OAUTH_PKCE");
    expect(getProviderPolicy("cloudflare-workers-ai")?.authMode).toBe("ACCOUNT_CONNECT");
    expect(getProviderPolicy("google")?.freePrivacyClass).toBe("permissive");
    expect(getProviderPolicy("google")?.hasAllowanceFree).toBe(true);
    expect(getProviderPolicy("openai")?.paidOnly).toBe(true);
    expect(getProviderPolicy("zai")?.allowLiveCatalogZeroUnitInference).toBe(true);
    expect(PROVIDER_POLICIES["codeforge-cloud"]).toBeUndefined();
  });

  it("treats $0 listings on promotional / dev-only / unreviewed providers as TRIAL, never free", () => {
    const zero = { inputPerMillion: 0, outputPerMillion: 0, currency: "USD" as const };
    const caps = { text: true, coding: true, toolCalling: true, vision: false, structuredOutput: true, longContext: true, reasoning: false };
    expect(deriveAccessClass("nvidia", zero, caps, getProviderPolicy("nvidia"))).toBe("TRIAL");
    expect(deriveAccessClass("cerebras", zero, caps, getProviderPolicy("cerebras"))).toBe("TRIAL");
    expect(deriveAccessClass("kilo", zero, caps, getProviderPolicy("kilo"))).toBe("TRIAL");
    expect(deriveAccessClass("poolside", zero, caps, getProviderPolicy("poolside"))).toBe("TRIAL");
    expect(deriveAccessClass("openrouter", zero, caps, getProviderPolicy("openrouter"))).toBe("FREE_ROUTED");
    expect(deriveAccessClass("zai", zero, caps, getProviderPolicy("zai"))).toBe("FREE_NATIVE");
    expect(deriveAccessClass("openai", zero, caps, getProviderPolicy("openai"))).toBe("PAID");
  });

  it("classifies every investigated provider with evidence and a terms status", () => {
    for (const def of Object.values(PROVIDER_DEFINITIONS)) {
      expect(def.freeAccess.evidence.source.length).toBeGreaterThan(0);
      expect(def.freeAccess.evidence.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(def.terms.status).toBeDefined();
    }
    expect(PROVIDER_DEFINITIONS.anthropic?.freeAccess.evidence.note).toContain("NO_SUPPORTED_ZERO_COST_ANTHROPIC_ROUTE");
    expect(PROVIDER_DEFINITIONS["github-copilot"]?.terms.status).toBe("NOT_ALLOWED");
  });

  it("merges Models.dev env aliases and discovers generic OpenAI-compatible providers as BYOK-only", () => {
    const merged = mergeModelsDevProviderHints([
      { id: "groq", env: ["GROQ_API_KEY", "GROQ_TOKEN"] },
      { id: "acme-inference", name: "Acme", env: ["ACME_API_KEY"], api: "https://api.acme.example/v1", npm: "@ai-sdk/openai-compatible" },
      { id: "no-api", env: ["X_KEY"], npm: "@ai-sdk/openai-compatible" },
      { id: "native-sdk", env: ["Y_KEY"], api: "https://y.example", npm: "@ai-sdk/y" },
    ]);
    expect(merged.groq?.connection.fields[0]?.environmentAliases).toContain("GROQ_TOKEN");
    expect(merged["acme-inference"]?.discovered).toBe(true);
    expect(merged["acme-inference"]?.freeAccess.class).toBe("LEGAL_REVIEW_REQUIRED");
    expect(merged["acme-inference"]?.terms.status).toBe("LEGAL_REVIEW_REQUIRED");
    expect(merged["no-api"]).toBeUndefined();
    expect(merged["native-sdk"]).toBeUndefined();
    // The curated table is never mutated.
    expect(PROVIDER_DEFINITIONS.groq?.connection.fields[0]?.environmentAliases).not.toContain("GROQ_TOKEN");
  });
});

describe("environment credential discovery", () => {
  const env = {
    GROQ_API_KEY: "gsk_test_secret_value_1234567890",
    GEMINI_API_KEY: "AIzaTESTSECRET0000000000000000000",
    OPENAI_API_KEY: "sk-paid-secret-000000000000000000",
    CLOUDFLARE_API_TOKEN: "cf-token-secret",
  };

  it("reports names and presence only — never values", () => {
    const detected = detectEnvironmentCredentials(presenceFromEnv(env));
    const serialized = JSON.stringify(detected);
    for (const value of Object.values(env)) expect(serialized).not.toContain(value);
    const groq = detected.find((d) => d.providerId === "groq")!;
    expect(groq.complete).toBe(true);
    expect(groq.fields[0]?.variable).toBe("GROQ_API_KEY");
    const google = detected.find((d) => d.providerId === "google")!;
    expect(google.fields[0]?.variable).toBe("GEMINI_API_KEY");
    const cf = detected.find((d) => d.providerId === "cloudflare-workers-ai")!;
    expect(cf.anyDetected).toBe(true);
    expect(cf.complete).toBe(false);
    const openai = detected.find((d) => d.providerId === "openai")!;
    expect(openai.paidOnly).toBe(true);
    expect(openai.zeroCashFreeAccess).toBe(false);
  });

  it("resolves values only for enabled preferences under the active policy", () => {
    const groq = PROVIDER_DEFINITIONS.groq!;
    const openai = PROVIDER_DEFINITIONS.openai!;
    expect(resolveEnvironmentField(env, groq, "apiKey", undefined, "FREE_ROUTES_ONLY")).toBeUndefined();
    expect(resolveEnvironmentField(env, groq, "apiKey", { providerId: "groq", enabled: false }, "FREE_ROUTES_ONLY")).toBeUndefined();
    expect(resolveEnvironmentField(env, groq, "apiKey", { providerId: "groq", enabled: true }, "FREE_ROUTES_ONLY")).toBe(env.GROQ_API_KEY);
    expect(resolveEnvironmentField(env, groq, "apiKey", { providerId: "groq", enabled: true }, "OFF")).toBeUndefined();
    // Paid providers never resolve under FREE_ROUTES_ONLY, even when enabled.
    expect(resolveEnvironmentField(env, openai, "apiKey", { providerId: "openai", enabled: true }, "FREE_ROUTES_ONLY")).toBeUndefined();
    expect(resolveEnvironmentField(env, openai, "apiKey", { providerId: "openai", enabled: true }, "ALL_ENABLED_BYOK_ROUTES")).toBe(env.OPENAI_API_KEY);
    // A variable that disappears makes the credential unavailable — no retained copy.
    expect(resolveEnvironmentField({}, groq, "apiKey", { providerId: "groq", enabled: true }, "FREE_ROUTES_ONLY")).toBeUndefined();
  });

  it("migrates only the legacy implicit env providers to enabled by default", () => {
    const detected = detectEnvironmentCredentials(presenceFromEnv({ ...env, OPENROUTER_API_KEY: "sk-or-v1-legacy", ZHIPU_API_KEY: "zai-legacy" }));
    const prefs = defaultEnvironmentPreferences(detected, () => NOW);
    expect(prefs.map((p) => p.providerId).sort()).toEqual(["openrouter", "zai"]);
    expect(prefs.every((p) => p.enabled)).toBe(true);
  });
});

describe("8-Bit admission pipeline", () => {
  it("walks every gate in order and explains the first failure", () => {
    const fw = new ForgeZero();
    const model = freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE", costProfile: { ...freeRecord("groq", "x").costProfile, inputCostPerMillion: 0.35, outputCostPerMillion: 0.75, isFree: false } });
    fw.register(model);
    const base = { def: PROVIDER_DEFINITIONS.groq, model, firewall: fw, toolSupport: true, qualification: "QUALIFIED" as const, health: "HEALTHY" as const, roles: [] };

    expect(evaluateAdmission({ ...base, conn: undefined }).failedGate).toBe("CONNECTED");
    expect(evaluateAdmission({ ...base, conn: connected("groq", { authState: "auth_required" }) }).failedGate).toBe("CONNECTED");
    // Account-dependent allowance without attestation cannot be verified free.
    const noAttest = evaluateAdmission({ ...base, conn: connected("groq") });
    expect(noAttest.failedGate).toBe("FREE_VERIFIED");
    expect(noAttest.reason).toMatch(/free plan/i);
    const attested = connected("groq", { planAttested: true });
    expect(evaluateAdmission({ ...base, conn: attested, toolSupport: false }).failedGate).toBe("CAPABILITY_VERIFIED");
    expect(evaluateAdmission({ ...base, conn: attested, qualification: "NOT_TESTED" }).failedGate).toBe("CODEFORGE_QUALIFIED");
    expect(evaluateAdmission({ ...base, conn: attested, health: "COOLDOWN" }).failedGate).toBe("HEALTHY");
    expect(evaluateAdmission({ ...base, conn: attested }).state).toBe("FORGEAUTO_ELIGIBLE");
  });

  it("fails closed for Gemini until the current free-tier policy gate allows the route", () => {
    const fw = new ForgeZero();
    const model = freeRecord("google", "gemini-3.8-flash");
    fw.register(model);
    const base = { def: PROVIDER_DEFINITIONS.google, model, firewall: fw, toolSupport: true, qualification: "QUALIFIED" as const, health: "HEALTHY" as const, roles: [] };

    const denied = evaluateAdmission({ ...base, conn: connected("google") });
    expect(denied.failedGate).toBe("FREE_VERIFIED");
    expect(denied.reason).toMatch(/Gemini free policy gate/i);

    expect(evaluateAdmission({ ...base, conn: connected("google", { freePolicyState: "ALLOW", planAttested: true }) }).state).toBe("FORGEAUTO_ELIGIBLE");
  });

  it("never admits promotional, dev-only, paid or legally unreviewed providers", () => {
    const fw = new ForgeZero();
    for (const providerId of ["cerebras", "nvidia", "openai", "kilo", "poolside", "github-copilot"]) {
      const model = freeRecord(providerId, "m");
      fw.register(model);
      const r = evaluateAdmission({ def: PROVIDER_DEFINITIONS[providerId], conn: connected(providerId, { planAttested: true }), model, firewall: fw, toolSupport: true, qualification: "QUALIFIED", health: "HEALTHY", roles: [] });
      expect(r.failedGate, providerId).toBeDefined();
      expect(["TERMS_ALLOWED", "AUTH_SUPPORTED"]).toContain(r.failedGate);
    }
  });

  it("rejects stale free evidence (older than ForgeZero's 7-day window)", () => {
    const fw = new ForgeZero();
    const stale = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const model = freeRecord("zai", "glm-4.7-flash", { freeStatusVerifiedAt: stale, lastVerified: stale, costProfile: { ...freeRecord("zai", "x").costProfile, freeTierVerifiedAt: stale } });
    fw.register(model);
    const r = evaluateAdmission({ def: PROVIDER_DEFINITIONS.zai, conn: connected("zai"), model, firewall: fw, toolSupport: true, qualification: "QUALIFIED", health: "HEALTHY", roles: [] });
    expect(r.failedGate).toBe("FREE_VERIFIED");
  });
});

describe("free cloud snapshot", () => {
  function build() {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE" }));
    fw.register(freeRecord("openrouter", "openai/gpt-oss-120b:free"));
    fw.register(freeRecord("openrouter", "poolside/laguna-s-2.1:free"));
    fw.register(freeRecord("openrouter", "liquid/lfm-2.5-2.6b:free", { capabilities: { text: true, coding: true, toolCalling: false, vision: false, structuredOutput: false, longContext: false } }));
    fw.register(freeRecord("openai", "gpt-5", { freeStatus: "paid", accessClass: "PAID", costProfile: { ...freeRecord("openai", "x").costProfile, inputCostPerMillion: 2, outputCostPerMillion: 8, isFree: false } }));
    const qualification = new Map<string, ModelQualificationReceipt>([
      ["groq::openai/gpt-oss-120b", receipt("groq", "openai/gpt-oss-120b")],
      ["openrouter::openai/gpt-oss-120b:free", receipt("openrouter", "openai/gpt-oss-120b:free")],
    ]);
    return { fw, qualification };
  }

  it("dedupes routes into canonical models with truthful readiness and counts", () => {
    const { fw, qualification } = build();
    const snap = buildFreeCloudSnapshot({
      firewall: fw,
      connections: [connected("groq", { planAttested: true }), connected("openrouter", { credentialSource: "OAUTH" }), connected("openai")],
      qualification,
      now: () => NOW,
    });
    const gptOss = snap.models.find((m) => m.canonicalId === "openai/gpt-oss-120b")!;
    expect(gptOss.routes.length).toBe(2);
    expect(gptOss.readiness).toBe("FREE_AVAILABLE");
    expect(gptOss.healthyFreeRouteCount).toBe(2);
    expect(gptOss.freeBadge).toBe("Free · 2 routes");
    expect(gptOss.roles).toContain("PRIMARY_CODING_AGENT");
    expect(gptOss.category).toBe("Recommended");

    const laguna = snap.models.find((m) => m.canonicalId === "poolside/laguna-s-2.1")!;
    expect(laguna.readiness).toBe("FREE_AVAILABLE");
    expect(laguna.forgeAutoEligible).toBe(false);
    expect(laguna.routes[0]?.admission.failedGate).toBe("CODEFORGE_QUALIFIED");

    const safety = snap.models.find((m) => m.canonicalId === "liquid/lfm-2.5-2.6b")!;
    expect(safety.routes[0]?.admission.failedGate).toBe("CAPABILITY_VERIFIED");

    const paid = snap.models.find((m) => m.canonicalId === "openai/gpt-5")!;
    expect(paid.readiness).toBe("PAID_BYOK");
    expect(paid.forgeAutoEligible).toBe(false);

    expect(snap.summary.paidRoutesExcluded).toBe(1);
    expect(snap.summary.sameModelMultiProviderModels).toBe(1);
    expect(snap.summary.primaryCodingModels).toBe(1);
    expect(snap.summary.connectedProviders).toBe(3);
  });

  it("offers the lowest-friction connection for models with no connected route", () => {
    const { fw } = build();
    const snap = buildFreeCloudSnapshot({
      firewall: fw,
      connections: [
        { providerId: "groq", connected: false, credentialSource: "NONE", authState: "unknown", connectOffer: { authClass: "ENVIRONMENT_CREDENTIAL", label: "Use detected GROQ_API_KEY", environmentVariable: "GROQ_API_KEY" } },
        { providerId: "openrouter", connected: false, credentialSource: "NONE", authState: "unknown", connectOffer: { authClass: "OAUTH_PKCE", label: "OpenRouter · one-click account connection" } },
      ],
      now: () => NOW,
    });
    const gptOss = snap.models.find((m) => m.canonicalId === "openai/gpt-oss-120b")!;
    expect(gptOss.readiness).toBe("FREE_CONNECT_REQUIRED");
    expect(gptOss.freeBadge).toBe("Free · Connect");
    expect(gptOss.connectOffer?.authClass).toBe("OAUTH_PKCE");
  });

  it("includes Models.dev discovery candidates for implemented providers that are not connected", () => {
    const fw = new ForgeZero();
    const registry = new NormalizedModelRegistry();
    registry.loadDoc(
      {
        zai: { id: "zai", models: { "glm-4.7-flash": { id: "glm-4.7-flash", name: "GLM-4.7-Flash", tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 200000 } } } },
        nvidia: { id: "nvidia", models: { "nvidia/nemotron-3-super-120b-a12b": { id: "nvidia/nemotron-3-super-120b-a12b", tool_call: true, cost: { input: 0, output: 0 } } } },
      },
      "live",
      NOW.toISOString(),
    );
    const snap = buildFreeCloudSnapshot({ firewall: fw, registry, connections: [], now: () => NOW });
    const glm = snap.models.find((m) => m.canonicalId === "zai/glm-4.7-flash");
    expect(glm?.readiness).toBe("FREE_CONNECT_REQUIRED");
    // NVIDIA's $0 listing is a dev endpoint → TRIAL → not a free candidate at all.
    expect(snap.models.find((m) => m.canonicalId.includes("nemotron-3-super"))).toBeUndefined();
  });

  it("does not report a quota-exhausted route as executable for exact selection", () => {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b"));
    const snap = buildFreeCloudSnapshot({
      firewall: fw,
      connections: [connected("groq", { planAttested: true })],
      qualification: new Map([["groq::openai/gpt-oss-120b", receipt("groq", "openai/gpt-oss-120b")]]),
      routeHealth: () => ({ status: "QUOTA_EXHAUSTED" }),
      now: () => NOW,
    });
    const route = snap.models[0]!.routes[0]!;
    expect(route.health).toBe("QUOTA_EXHAUSTED");
    expect(route.executable).toBe(false);
    expect(route.forgeAutoEligible).toBe(false);
    expect(snap.models[0]!.readiness).toBe("FREE_TEMPORARILY_UNAVAILABLE");
    // RC-6: capability-qualified is not runnable — a quota-exhausted QUALIFIED+PRIMARY model
    // must never present as "Recommended" (the DeepSeek smoke defect).
    expect(snap.models[0]!.category).toBe("Strong");
    expect(snap.summary.qualifiedPrimaryCodingModels).toBe(1);
    expect(snap.summary.recommendedModels).toBe(0);
    expect(snap.summary.runnableFreeModels).toBe(0);
  });

  it("labels each route with the economic supply class of its capacity (RC-5)", () => {
    const { fw, qualification } = build();
    const snap = buildFreeCloudSnapshot({
      firewall: fw,
      connections: [
        connected("groq", { planAttested: true }),
        // The smoke defect: a provider key living in a developer's environment is
        // OWNER_DEV_FREE supply, not product managed-free capacity.
        connected("openrouter", { credentialSource: "ENVIRONMENT", environmentVariable: "OPENROUTER_API_KEY" }),
      ],
      qualification,
      now: () => NOW,
    });
    const gptOss = snap.models.find((m) => m.canonicalId === "openai/gpt-oss-120b")!;
    const supplyByProvider = new Map(gptOss.routes.map((r) => [r.providerId, r.supplyClass]));
    expect(supplyByProvider.get("groq")).toBe("USER_CONNECTED_FREE");
    expect(supplyByProvider.get("openrouter")).toBe("OWNER_DEV_FREE");

    // The hosted first-party gateway is managed product supply regardless of credential shape.
    expect(supplyClassFor(PROVIDER_DEFINITIONS["codeforge-cloud"], undefined)).toBe("PURE_MANAGED_FREE");
    expect(supplyClassFor(PROVIDER_DEFINITIONS["codeforge-cloud"], { credentialSource: "FDS_GATEWAY", connected: true })).toBe("PURE_MANAGED_FREE");
    // Paid and unverifiable providers never masquerade as free supply.
    expect(supplyClassFor(PROVIDER_DEFINITIONS.openai, connected("openai"))).toBe("USER_CONNECTED_FREE");
    expect(supplyClassFor(PROVIDER_DEFINITIONS.openai, undefined)).toBe("PAID");
    expect(supplyClassFor(undefined, undefined)).toBeUndefined();

    const summary = snap.summary;
    expect(summary.userOwnedFreeRoutes).toBeGreaterThanOrEqual(1);
    expect(summary.ownerDevFreeRoutes).toBeGreaterThanOrEqual(1);
    expect(summary.managedFreeRoutes).toBe(0);
    // Runnable is a strict subset of qualified in this snapshot: all three free models run
    // (groq + env-connected openrouter routes), but only the QUALIFIED+PRIMARY one recommends.
    expect(summary.recommendedModels).toBeLessThanOrEqual(summary.qualifiedPrimaryCodingModels);
    expect(summary.runnableFreeModels).toBe(3);
    expect(summary.recommendedModels).toBe(1);
  });

  it("does not report an unaccepted Gemini route as executable", () => {
    const fw = new ForgeZero();
    fw.register(freeRecord("google", "gemini-3.8-flash"));
    const snap = buildFreeCloudSnapshot({ firewall: fw, connections: [connected("google")], now: () => NOW });
    const route = snap.models.find((m) => m.canonicalId === "google/gemini-3.8-flash")?.routes[0];
    expect(route?.executable).toBe(false);
    expect(route?.forgeAutoEligible).toBe(false);
    expect(route?.admission.reason).toMatch(/Gemini free policy gate/i);
  });
});

describe("quota capture", () => {
  it("parses standard rate-limit headers and Groq durations without inventing values", () => {
    const q = parseRouteQuota(
      [
        ["x-ratelimit-limit-requests", "1000"],
        ["x-ratelimit-remaining-requests", "998"],
        ["x-ratelimit-reset-requests", "2m59.56s"],
        ["retry-after", "7"],
      ],
      () => NOW,
    )!;
    expect(q.limitRequests).toBe(1000);
    expect(q.remainingRequests).toBe(998);
    expect(q.retryAfterMs).toBe(7000);
    expect(new Date(q.resetAt!).getTime() - NOW.getTime()).toBeCloseTo(179560, -2);
    expect(parseRouteQuota([["content-type", "application/json"]], () => NOW)).toBeUndefined();
  });
});

describe("FreeCloudService", () => {
  function service() {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE" }));
    fw.register(freeRecord("openrouter", "openai/gpt-oss-120b:free"));
    fw.register(freeRecord("openrouter", "poolside/laguna-s-2.1:free"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "groq" }));
    catalog.register(createMockProvider({ providerId: "openrouter" }));
    const registry = new NormalizedModelRegistry();
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry,
      now: () => NOW,
      qualificationCycleIntervalMs: 0,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId, model.modelId.includes("laguna") ? "NOT_QUALIFIED" : "QUALIFIED"),
    });
    svc.setConnection(connected("groq", { planAttested: true }));
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH" }));
    return { svc, fw };
  }

  it("qualifies pending routes within budget and then admits them to ForgeAuto", async () => {
    const { svc } = service();
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);
    expect(svc.pendingQualification().length).toBe(3);
    const produced = await svc.qualifyPending({ budget: 2 });
    expect(produced.length).toBe(2);
    // Same-model multi-route model is prioritized over the single-route one.
    expect(produced.map((r) => r.modelId)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b:free"]);
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);
    await svc.qualifyPending();
    expect(svc.isForgeAutoEligible("openrouter", "poolside/laguna-s-2.1:free")).toBe(false);
    expect(svc.snapshot().models.find((m) => m.canonicalId === "poolside/laguna-s-2.1")?.routes[0]?.qualificationState).toBe("NOT_QUALIFIED");
  });

  it("prefers same-model alternates and cools down failed routes", async () => {
    const { svc } = service();
    await svc.qualifyPending({ budget: 3 });
    expect(svc.sameModelAlternates("groq", "openai/gpt-oss-120b")).toEqual([{ providerId: "openrouter", modelId: "openai/gpt-oss-120b:free" }]);
    svc.recordRouteFailure("groq", "openai/gpt-oss-120b", "RATE_LIMITED", 60_000);
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(false);
    expect(svc.snapshot().summary.coolingDown).toBe(1);
    expect(svc.sameModelAlternates("openrouter", "openai/gpt-oss-120b:free")).toEqual([]);
    svc.recordRouteSuccess("groq", "openai/gpt-oss-120b");
    expect(svc.isForgeAutoEligible("groq", "openai/gpt-oss-120b")).toBe(true);
  });

  it("honors a provider reset horizon when a 429 omits Retry-After", async () => {
    const { svc } = service();
    await svc.qualifyPending({ budget: 3 });
    const resetAt = new Date(NOW.getTime() + 6 * 60 * 60_000).toISOString();
    svc.onProviderResponse({
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b:free",
      status: 429,
      headers: [
        ["x-ratelimit-remaining-requests", "0"],
        ["x-ratelimit-reset-requests", resetAt],
      ],
      observedAt: NOW.getTime(),
    });

    const route = svc.snapshot().models
      .flatMap((model) => model.routes)
      .find((candidate) => candidate.providerId === "openrouter" && candidate.providerModelId === "openai/gpt-oss-120b:free");
    expect(route?.forgeAutoEligible).toBe(false);
    expect(route?.cooldownUntil).toBe(Date.parse(resetAt));
    expect(route?.capacityState).toBe("SATURATED");
  });

  it("keeps a route out of ForgeAuto before dispatch when a successful response reports zero remaining quota", async () => {
    const { svc } = service();
    await svc.qualifyPending({ budget: 3 });
    const resetAt = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    svc.onProviderResponse({
      providerId: "openrouter",
      modelId: "openai/gpt-oss-120b:free",
      status: 200,
      headers: [["x-ratelimit-remaining-requests", "0"], ["x-ratelimit-reset-requests", resetAt]],
      observedAt: NOW.getTime(),
    });
    expect(svc.isForgeAutoEligible("openrouter", "openai/gpt-oss-120b:free")).toBe(false);
    expect(svc.snapshot().models.flatMap((model) => model.routes).find((route) => route.providerId === "openrouter" && route.providerModelId === "openai/gpt-oss-120b:free")?.capacityState).toBe("SATURATED");
    expect(svc.capacityRoutingAdvice("openrouter", "openai/gpt-oss-120b:free")).toEqual({
      scoreAdjustment: -100,
      reasonCodes: ["KNOWN_CAPACITY_EXHAUSTED"],
    });
  });

  it("enforces the per-provider daily qualification budget and cycle interval", async () => {
    const fw = new ForgeZero();
    for (let i = 0; i < 6; i++) fw.register(freeRecord("openrouter", `vendor/model-${i}:free`));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "openrouter" }));
    let clock = NOW.getTime();
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => new Date(clock),
      qualificationDailyBudgetPerProvider: 6,
      qualificationCycleIntervalMs: 60_000,
      maxQualificationsPerCycle: 5,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId),
    });
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH" }));
    // Interval: only the first route of a provider starts a cycle; budget 6 requests = 2 routes.
    expect((await svc.qualifyPending()).length).toBe(2);
    expect(svc.qualificationAllowed("openrouter")).toBe(false);
    clock += 61_000;
    // Budget for the day is exhausted → nothing more today even after the interval.
    expect((await svc.qualifyPending()).length).toBe(0);
    clock += 24 * 60 * 60_000;
    expect((await svc.qualifyPending()).length).toBe(2);
  });

  it("does not let a transiently failing route consume cycle slots or keep head-of-queue priority", async () => {
    // Observed in R5: an upstream-rate-limited route (poolside/laguna) sat first in the queue by
    // family prior; every cycle spent slots re-probing it and its sibling, and the never-tested
    // candidates behind them were starved.
    const fw = new ForgeZero();
    fw.register(freeRecord("openrouter", "poolside/laguna-xs-2.1:free"));
    fw.register(freeRecord("openrouter", "vendor/model-a:free"));
    fw.register(freeRecord("openrouter", "vendor/model-b:free"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "openrouter" }));
    let clock = NOW.getTime();
    const runs: string[] = [];
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => new Date(clock),
      maxQualificationsPerCycle: 2,
      qualificationDailyBudgetPerProvider: 30,
      qualificationCycleIntervalMs: 0,
      failureCooldownMs: 1_000,
      qualificationRunner: async (model) => {
        runs.push(model.modelId);
        if (model.modelId.startsWith("poolside/")) {
          return { ...receipt(model.providerId, model.modelId, "NOT_QUALIFIED"), metadata: { compact: true, requests: 1, transient: true } };
        }
        return receipt(model.providerId, model.modelId);
      },
    });
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH" }));
    expect(svc.pendingQualification()[0]?.providerModelId).toBe("poolside/laguna-xs-2.1:free");

    // Cycle 1: the transient probe does not use one of the two slots; two real routes get scored.
    const produced = await svc.qualifyPending();
    expect(produced.map((r) => r.modelId).sort()).toEqual(["vendor/model-a:free", "vendor/model-b:free"]);
    expect(runs).toEqual(["poolside/laguna-xs-2.1:free", "vendor/model-a:free", "vendor/model-b:free"]);
    expect(svc.isForgeAutoEligible("openrouter", "poolside/laguna-xs-2.1:free")).toBe(false);

    // After its cooldown the transiently failed route is still pending but ranks behind any
    // never-tested route rather than reclaiming the head of the queue.
    clock += 5_000;
    fw.register(freeRecord("openrouter", "vendor/model-c:free"));
    const pending = svc.pendingQualification().map((r) => r.providerModelId);
    expect(pending).toEqual(["vendor/model-c:free", "poolside/laguna-xs-2.1:free"]);
  });

  it("a model-scoped 429 must not contaminate sibling routes on the same provider (R15 regression)", () => {
    // Observed native smoke 2026-09-18: one OpenRouter :free model's daily-cap 429 poisoned the
    // provider-level quota bucket, so every OpenRouter route showed QUOTA_EXHAUSTED — including
    // deepseek-v4-flash, which was still returning HTTP 200.
    const { svc } = service();
    svc.onProviderResponse({
      providerId: "openrouter",
      modelId: "poolside/laguna-s-2.1:free",
      status: 429,
      headers: [
        ["x-ratelimit-limit", "1000"],
        ["x-ratelimit-remaining", "0"],
        ["x-ratelimit-reset", String(NOW.getTime() + 60 * 60_000)],
      ],
      observedAt: NOW.getTime(),
    });
    const routes = svc.snapshot().models.flatMap((m) => m.routes).filter((r) => r.providerId === "openrouter");
    const laguna = routes.find((r) => r.providerModelId === "poolside/laguna-s-2.1:free");
    const sibling = routes.find((r) => r.providerModelId === "openai/gpt-oss-120b:free");
    // The route that took the 429 is blocked (rate-limit cooldown toward the observed reset).
    expect(["COOLDOWN", "QUOTA_EXHAUSTED"]).toContain(laguna?.health);
    // The sibling route observed nothing itself: it must NOT inherit the exhausted verdict.
    expect(sibling?.health).toBe("HEALTHY");
    expect(sibling?.cooldownUntil).toBeUndefined();
    expect(svc.quotaRemaining("openrouter", "openai/gpt-oss-120b:free")).toBeUndefined();
  });

  it("a genuinely provider-scoped observation (no model attached) still applies provider-wide", () => {
    const { svc } = service();
    svc.onProviderResponse({
      providerId: "openrouter",
      modelId: undefined,
      status: 200,
      headers: [
        ["x-ratelimit-remaining", "0"],
        ["x-ratelimit-reset", String(NOW.getTime() + 60 * 60_000)],
      ],
      observedAt: NOW.getTime(),
    });
    expect(svc.quotaRemaining("openrouter", "openai/gpt-oss-120b:free")).toBe(0);
  });

  it("records quota from provider responses and reacts to 429/402", () => {
    const { svc } = service();
    svc.onProviderResponse({ providerId: "groq", modelId: "openai/gpt-oss-120b", status: 200, headers: [["x-ratelimit-remaining-requests", "5"]], observedAt: NOW.getTime() });
    expect(svc.quotaRemaining("groq", "openai/gpt-oss-120b")).toBe(5);
    svc.onProviderResponse({ providerId: "openrouter", modelId: "openai/gpt-oss-120b:free", status: 402, headers: [], observedAt: NOW.getTime() });
    expect(svc.snapshot().models.find((m) => m.canonicalId === "openai/gpt-oss-120b")?.routes.find((r) => r.providerId === "openrouter")?.health).toBe("UNAVAILABLE");
  });
});
