import { describe, expect, it } from "vitest";
import { ForgeZero, CapacityReservationLedger, freeRouteExclusionReason, type FreeModelRecord } from "@codeforge/forge-zero";
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
  effectiveQuota,
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
    // The official @github/copilot-sdk is a supported user-delegated surface; the route remains
    // unimplemented and legally unreviewed, not impossible (R23 M14A evidence).
    expect(PROVIDER_DEFINITIONS["github-copilot"]?.terms.status).toBe("LEGAL_REVIEW_REQUIRED");
    expect(PROVIDER_DEFINITIONS["github-copilot"]?.implemented).toBe(false);
    expect(PROVIDER_DEFINITIONS["github-copilot"]?.userConnectedFree?.supplyClass).toBe("USER_CONNECTED_FREE");
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

  it("parses Mistral per-minute header aliases — measured live on codestral-latest", () => {
    const q = parseRouteQuota(
      [
        ["x-ratelimit-limit-req-minute", "125"],
        ["x-ratelimit-remaining-req-minute", "124"],
        ["x-ratelimit-limit-tokens-minute", "625000"],
        ["x-ratelimit-remaining-tokens-minute", "624990"],
      ],
      () => NOW,
    )!;
    expect(q.limitRequests).toBe(125);
    expect(q.remainingRequests).toBe(124);
    expect(q.limitTokens).toBe(625000);
    expect(q.remainingTokens).toBe(624990);
  });

  it("effectiveQuota refills a window whose declared reset elapsed, and keeps a stale zero when no limit was observed", () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      effectiveQuota(
        { limitRequests: 1000, remainingRequests: 0, resetAt: past, observedAt: NOW.toISOString() },
        () => NOW,
      ),
    ).toEqual({ limitRequests: 1000, remainingRequests: 1000, resetAt: undefined, observedAt: NOW.toISOString() });
    expect(
      effectiveQuota(
        { remainingRequests: 0, resetAt: past, observedAt: NOW.toISOString() },
        () => NOW,
      )?.remainingRequests,
    ).toBe(0);
    expect(
      effectiveQuota(
        { limitRequests: 1000, remainingRequests: 0, resetAt: future, observedAt: NOW.toISOString() },
        () => NOW,
      )?.remainingRequests,
    ).toBe(0);
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

  it("refills declared-reset windows instead of stranding the pool on a stale zero", async () => {
    const { svc } = service();
    await svc.qualifyPending({ budget: 3 });
    // Observation made before the reset elapsed: remaining 0, limit 1000, reset already past.
    const pastReset = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    svc.onProviderResponse({
      providerId: "groq",
      modelId: "openai/gpt-oss-120b",
      status: 200,
      headers: [
        ["x-ratelimit-limit-requests", "1000"],
        ["x-ratelimit-remaining-requests", "0"],
        ["x-ratelimit-reset-requests", pastReset],
      ],
      observedAt: NOW.getTime() - 6 * 60_000,
    });
    expect(svc.capacityRoutingAdvice("groq", "openai/gpt-oss-120b")).toEqual({
      scoreAdjustment: 0,
      reasonCodes: ["CAPACITY_AVAILABLE"],
    });
    expect(svc.quotaRemaining("groq", "openai/gpt-oss-120b")).toBe(1000);
    const route = svc
      .capacityRoutes()
      .find((candidate) => candidate.providerId === "groq" && candidate.modelId === "openai/gpt-oss-120b");
    const requests = route?.windows.find((w) => w.unit === "requests");
    expect(requests?.remaining).toBe(1000);
    expect(requests?.limit).toBe(1000);
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

describe("FreeCloudService — Free Fabric capacity projection", () => {
  function service() {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE" }));
    fw.register(freeRecord("openrouter", "openai/gpt-oss-120b:free"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "groq" }));
    catalog.register(createMockProvider({ providerId: "openrouter" }));
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => NOW,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId),
    });
    svc.setConnection(connected("groq", { planAttested: true }));
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH" }));
    return { svc, fw };
  }

  it("projects connected zero-cash routes with supply class, ownership, and honest health", async () => {
    const { svc } = service();
    const before = svc.capacityRoutes();
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (const route of before) {
      expect(route.paidFallbackDisabled).toBe(true);
      expect(route.explicitZeroPrice).toBe(true);
      expect(route.routeId.startsWith("fabric:")).toBe(true);
      // Nothing qualified yet → executable is false → the fabric sees UNHEALTHY, not a lie.
      expect(route.healthy).toBe(false);
    }
    const groq = before.find((r) => r.providerId === "groq");
    expect(groq?.supplyClass).toBe("USER_CONNECTED_FREE");
    expect(groq?.capacityPoolScope).toBe("PER_USER_POOL");
    expect(groq?.capacityScope).toBe("USER_ACCOUNT");
    // planAttested proves a free-plan account for the ACCOUNT_DEPENDENT spillover provider.
    expect(groq?.freeOnlyAdmissionProven).toBe(true);
    expect(groq?.capacityIdentity).toBe("localconn:groq");
    expect(groq?.capacityPoolId).toBe("groq:user:localconn:groq");
    const openrouter = before.find((r) => r.providerId === "openrouter");
    // Spillover NONE: the free surface cannot bill — proven without attestation.
    expect(openrouter?.freeOnlyAdmissionProven).toBe(true);

    await svc.qualifyPending({ budget: 3 });
    const after = svc.capacityRoutes();
    expect(after.find((r) => r.providerId === "groq")?.healthy).toBe(true);
  });

  it("never emits paid routes and carries provider-header quota into windows", () => {
    const { svc } = service();
    svc.onProviderResponse({
      providerId: "groq",
      modelId: "openai/gpt-oss-120b",
      status: 200,
      headers: [
        ["x-ratelimit-limit-requests", "1000"],
        ["x-ratelimit-remaining-requests", "750"],
        ["x-ratelimit-limit-tokens", "60000"],
        ["x-ratelimit-remaining-tokens", "45000"],
      ],
      observedAt: NOW.getTime(),
    });
    const groq = svc.capacityRoutes().find((r) => r.providerId === "groq");
    const requests = groq?.windows.find((w) => w.unit === "requests");
    const tokens = groq?.windows.find((w) => w.unit === "input_tokens");
    expect(requests?.remaining).toBe(750);
    expect(requests?.authoritative).toBe(true);
    expect(requests?.scope).toBe("USER_ACCOUNT");
    expect(tokens?.remaining).toBe(45000);
    expect(svc.capacityRoutes().every((r) => r.supplyClass !== "PAID")).toBe(true);
  });

  it("builds one physical pool per account and keeps provider-scoped quota at pool level", () => {
    const { svc } = service();
    svc.quota.record("groq", undefined, { remainingRequests: 100, limitRequests: 100, observedAt: NOW.toISOString() });
    const pools = svc.capacityPools();
    const groqPool = pools.find((p) => p.providerId === "groq");
    expect(groqPool?.scope).toBe("PER_USER_POOL");
    expect(groqPool?.capacityIdentity).toBe("localconn:groq");
    expect(groqPool?.windows.find((w) => w.unit === "requests")?.remaining).toBe(100);
    const openrouterPool = pools.find((p) => p.providerId === "openrouter");
    expect(openrouterPool?.capacityIdentity).toBe("localconn:openrouter");
    // Pool ids are distinct physical accounts — two providers never share a bucket.
    expect(new Set(pools.map((p) => p.poolId)).size).toBe(pools.length);
  });

  it("scopes per-user routes and pools to the stamped connection owner and to no one else", () => {
    const { svc } = service();
    // Re-stamp connections as owned by alice — the desktop host stamps ownerUserId on every
    // connection state it publishes (provider-connections.ts).
    svc.setConnection(connected("groq", { planAttested: true, ownerUserId: "alice" }));
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH", ownerUserId: "alice" }));

    const aliceRoutes = svc.routesForUser("alice");
    expect(aliceRoutes.length).toBeGreaterThanOrEqual(2);
    expect(aliceRoutes.every((r) => r.capacityPoolScope === "PER_USER_POOL")).toBe(true);
    const alicePools = svc.poolsForUser("alice");
    expect(alicePools.length).toBe(2);
    expect(alicePools.every((p) => p.scope === "PER_USER_POOL")).toBe(true);

    // Bob sees none of Alice's supply — per-user capacity is never aggregated or leaked.
    expect(svc.routesForUser("bob")).toEqual([]);
    expect(svc.poolsForUser("bob")).toEqual([]);

    // The identities a request may claim come from stamped connection state alone — the
    // localconn sentinel when no account hash was recorded.
    const identities = svc.capacityIdentitiesFor("alice").sort();
    expect(identities).toEqual(["localconn:groq", "localconn:openrouter"]);
    expect(svc.capacityIdentitiesFor("bob")).toEqual([]);
  });

  it("uses the stamped account capacityIdentity when the connection carries one", () => {
    const { svc } = service();
    svc.setConnection(connected("groq", {
      planAttested: true,
      ownerUserId: "alice",
      userConnectedFree: {
        featureFlag: "test",
        supplyClass: "USER_CONNECTED_FREE",
        status: "CONNECTED",
        capacityScope: "USER_ACCOUNT",
        capacityPoolId: "groq:user:acct-42",
        capacityIdentity: "acct-42",
        freeOnly: true,
        concurrencyLimit: 1,
        starterModelCount: 1,
        capacityConfidence: "HIGH",
        termsStatus: "USER_CONNECTED_FREE_ALLOWED",
      },
    }));

    expect(svc.capacityIdentitiesFor("alice")).toEqual(["acct-42"]);
    const routes = svc.routesForUser("alice");
    expect(routes.some((r) => r.providerId === "groq" && r.capacityIdentity === "acct-42" && r.capacityPoolId === "groq:user:acct-42")).toBe(true);
    expect(svc.poolsForUser("alice").some((p) => p.capacityIdentity === "acct-42")).toBe(true);
    expect(svc.routesForUser("mallory").every((r) => r.providerId !== "groq")).toBe(true);
  });

  it("R34 Mission C: model-domain providers shard into independent physical pools — reservations on one model do not deny another", () => {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE" }));
    fw.register(freeRecord("groq", "qwen/qwen3-32b", { accessClass: "FREE_ALLOWANCE" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "groq" }));
    // Managed-supply variant of the Groq definition: FREE_PRODUCT_ONLY yields
    // PURE_MANAGED_FREE — the product-eligible class the sharding actually serves.
    const managedGroq = {
      ...PROVIDER_DEFINITIONS.groq,
      freeAccess: { ...PROVIDER_DEFINITIONS.groq.freeAccess, class: "FREE_PRODUCT_ONLY" as const, quotaDomain: "model" as const },
      terms: { status: "CLEARED" as const },
    };
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      definitions: { groq: managedGroq },
      now: () => NOW,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId),
    });
    svc.setConnection(connected("groq", { credentialSource: "FDS_GATEWAY" }));
    // R33 measured: each Groq model carries an independent quota window.
    svc.quota.record("groq", "openai/gpt-oss-120b", { remainingRequests: 1000, limitRequests: 1000, remainingTokens: 8000, limitTokens: 8000, observedAt: NOW.toISOString() });
    svc.quota.record("groq", "qwen/qwen3-32b", { remainingRequests: 1000, limitRequests: 1000, remainingTokens: 8000, limitTokens: 8000, observedAt: NOW.toISOString() });

    const routes = svc.capacityRoutes();
    const gptOss = routes.find((r) => r.providerId === "groq" && r.modelId === "openai/gpt-oss-120b");
    const qwen = routes.find((r) => r.providerId === "groq" && r.modelId === "qwen/qwen3-32b");
    expect(gptOss?.capacityPoolId).toBe("shared:groq:model:openai/gpt-oss-120b");
    expect(qwen?.capacityPoolId).toBe("shared:groq:model:qwen/qwen3-32b");

    const pools = svc.capacityPools();
    expect(pools.some((p) => p.poolId === "shared:groq:model:openai/gpt-oss-120b")).toBe(true);
    expect(pools.some((p) => p.poolId === "shared:groq:model:qwen/qwen3-32b")).toBe(true);
    // No dead account-level pool when no provider-scoped observation exists.
    expect(pools.some((p) => p.poolId === "shared:groq")).toBe(false);

    // Ledger proof: a reservation consuming most of model A's pool must not deny model B —
    // the quota domains are physically independent.
    const ledger = new CapacityReservationLedger({
      routes: routes.map((r) => ({ ...r, roles: ["CODER"], enabled: true, healthy: true, lifecycle: "APPROVED" as const })),
      pools,
      firstRunReserveRequests: 0,
      firstRunReserveTokens: 0,
      maxActiveReservationsPerUser: 10,
      now: () => NOW.getTime(),
    });
    const reqBase = { userId: "u1", role: "CODER", taskKind: "interactive_turn", requests: 1, outputTokens: 0, isNewUser: false, priority: "normal" as const, createdAt: NOW.toISOString(), leaseUntil: new Date(NOW.getTime() + 60_000).toISOString() };
    const reserveA = ledger.reserve({ ...reqBase, reservationId: "res-a", routeIds: [gptOss!.routeId], inputTokens: 6_000 });
    expect(reserveA.admitted).toBe(true);
    const reserveB = ledger.reserve({ ...reqBase, reservationId: "res-b", routeIds: [qwen!.routeId], inputTokens: 6_000 });
    expect(reserveB.admitted).toBe(true);

    // And the account-scoped collapse: a provider-wide observation un-shards back to one pool.
    svc.quota.record("groq", undefined, { remainingRequests: 30, limitRequests: 30, observedAt: NOW.toISOString() });
    const collapsed = svc.capacityRoutes();
    expect(collapsed.find((r) => r.providerId === "groq" && r.modelId === "openai/gpt-oss-120b")?.capacityPoolId).toBe("shared:groq");
    expect(svc.capacityPools().some((p) => p.poolId === "shared:groq")).toBe(true);
    expect(svc.capacityPools().some((p) => p.poolId.includes(":model:"))).toBe(false);
  });
});

describe("FreeCloudService — managed pools & quarantine (R34 Mission B)", () => {
  function managedService() {
    const fw = new ForgeZero();
    fw.register(freeRecord("mistral", "codestral-latest"));
    fw.register(freeRecord("mistral", "mistral-small-latest"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "mistral" }));
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => NOW,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId),
    });
    return { svc, fw };
  }

  it("projects one route per registered managed account with PURE_MANAGED_FREE supply", () => {
    const { svc } = managedService();
    svc.registerManagedPool("mistral", "acct-a");
    svc.registerManagedPool("mistral", "acct-b");

    const routes = svc.capacityRoutes().filter((r) => r.providerId === "mistral" && r.capacityPoolId.startsWith("managed:"));
    // 2 models × 2 accounts — every physical quota domain gets its own route row.
    expect(routes.length).toBe(4);
    expect(routes.every((r) => r.supplyClass === "PURE_MANAGED_FREE")).toBe(true);
    expect(routes.every((r) => r.capacityPoolScope === "SHARED_OWNER_POOL")).toBe(true);
    const poolIds = new Set(routes.map((r) => r.capacityPoolId));
    // Mistral is a model-domain provider: each account shards per model.
    expect(poolIds).toEqual(new Set([
      "managed:mistral:acct-a:model:codestral-latest",
      "managed:mistral:acct-b:model:codestral-latest",
      "managed:mistral:acct-a:model:mistral-small-latest",
      "managed:mistral:acct-b:model:mistral-small-latest",
    ]));
    expect(routes.map((r) => r.capacityIdentity).sort()).toEqual([
      "managed:mistral:acct-a",
      "managed:mistral:acct-a",
      "managed:mistral:acct-b",
      "managed:mistral:acct-b",
    ]);
  });

  it("keeps account quota domains isolated — stamped observations land on their own pool", () => {
    const { svc } = managedService();
    svc.registerManagedPool("mistral", "acct-a");
    svc.registerManagedPool("mistral", "acct-b");

    // Account A reports its window; account B stays unobserved.
    svc.onProviderResponse({
      providerId: "mistral",
      modelId: "codestral-latest",
      accountId: "acct-a",
      status: 200,
      headers: [["x-ratelimit-remaining-requests", "120"], ["x-ratelimit-limit-requests", "125"]],
      observedAt: NOW.getTime(),
    });

    const routes = svc.capacityRoutes().filter((r) => r.providerId === "mistral" && r.modelId === "codestral-latest");
    const aRoute = routes.find((r) => r.capacityPoolId.includes("acct-a"));
    const bRoute = routes.find((r) => r.capacityPoolId.includes("acct-b"));
    expect(aRoute?.windows.find((w) => w.unit === "requests")?.remaining).toBe(120);
    // B is a distinct physical account — A's observation must not leak into its window.
    expect(bRoute?.windows.find((w) => w.unit === "requests")).toBeUndefined();

    const pools = svc.capacityPools();
    expect(pools.some((p) => p.poolId.includes("acct-a") && p.windows.some((w) => w.remaining === 120))).toBe(true);
    expect(pools.some((p) => p.poolId.includes("acct-b") && p.windows.length > 0)).toBe(false);
  });

  it("quarantining a pool instantly denies its routes — policy exclusion is immediate", () => {
    const { svc } = managedService();
    svc.registerManagedPool("mistral", "acct-a");
    svc.registerManagedPool("mistral", "acct-b");

    const before = svc.capacityRoutes().filter((r) => r.providerId === "mistral");
    expect(before.every((r) => r.enabled)).toBe(true);

    svc.quarantinePool("managed:mistral:acct-a:model:codestral-latest", "upstream abuse report");
    const during = svc.capacityRoutes().filter((r) => r.providerId === "mistral" && r.modelId === "codestral-latest");
    const qa = during.find((r) => r.capacityPoolId.includes("acct-a"));
    const qb = during.find((r) => r.capacityPoolId.includes("acct-b"));
    expect(qa?.enabled).toBe(false);
    expect(qa?.lifecycle).toBe("QUARANTINED");
    // DISABLED is the first policy gate — quarantined routes fail closed before any other check.
    expect(freeRouteExclusionReason(qa!)).toBe("DISABLED");
    // The sibling account is untouched — quarantine is physical-pool precise.
    expect(qb?.enabled).toBe(true);
    expect(qb?.lifecycle).toBe("APPROVED");

    expect(svc.poolQuarantineOf("managed:mistral:acct-a:model:codestral-latest")?.reason).toBe("upstream abuse report");

    expect(svc.releasePoolQuarantine("managed:mistral:acct-a:model:codestral-latest")).toBe(true);
    expect(svc.capacityRoutes().find((r) => r.capacityPoolId.includes("acct-a") && r.modelId === "codestral-latest")?.enabled).toBe(true);
  });

  it("setManagedPoolState DISABLED/QUARANTINED denies instantly and ACTIVE restores", () => {
    const { svc } = managedService();
    const pool = svc.registerManagedPool("mistral", "acct-a");

    svc.setManagedPoolState(pool.poolId, "DISABLED", "credential revoked");
    for (const r of svc.capacityRoutes().filter((x) => x.providerId === "mistral" && x.capacityPoolId.includes("acct-a"))) {
      expect(r.enabled).toBe(false);
      expect(freeRouteExclusionReason(r)).toBe("DISABLED");
    }
    svc.setManagedPoolState(pool.poolId, "ACTIVE");
    expect(svc.capacityRoutes().filter((x) => x.capacityPoolId.includes("acct-a")).every((x) => x.enabled)).toBe(true);
  });

  it("refuses to register supply that cannot own a managed pool", () => {
    const { svc } = managedService();
    expect(() => svc.registerManagedPool("nonexistent", "a1")).toThrow(/unknown provider/);
    expect(() => svc.registerManagedPool("mistral", "")).toThrow(/accountId/);
    expect(() => svc.registerManagedPool("mistral", "a1", { supplyClass: "PAID" })).toThrow(/cannot own a managed pool/);
    expect(() => svc.registerManagedPool("mistral", "a1", { supplyClass: "USER_CONNECTED_FREE" })).toThrow(/cannot own a managed pool/);
    expect(svc.managedPoolsFor("mistral")).toEqual([]);
  });

  it("quarantine survives a store-backed reload — disabled supply never silently reopens", async () => {
    const { InMemoryManagedPoolPersistence } = await import("../src/index.js");
    const store = new InMemoryManagedPoolPersistence();
    const { svc } = managedService();
    svc.attachManagedPoolStore(store);
    const pool = svc.registerManagedPool("mistral", "acct-a");
    svc.setManagedPoolState(pool.poolId, "QUARANTINED", "abuse");
    // Give the fire-and-forget persistence a tick to flush.
    await new Promise((r) => setTimeout(r, 0));

    // Simulate a restart: a fresh service restores from the same store.
    const { svc: restored } = managedService();
    restored.attachManagedPoolStore(store);
    await restored.loadManagedPools();
    const routes = restored.capacityRoutes().filter((x) => x.providerId === "mistral" && x.capacityPoolId.includes("acct-a"));
    expect(routes.every((x) => x.enabled === false && x.lifecycle === "QUARANTINED")).toBe(true);
    expect(restored.poolQuarantineOf(pool.poolId)?.reason).toBe("abuse");
  });

  it("a managed pool on a user-connected provider adds a distinct managed domain — no double counting", () => {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE" }));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "groq" }));
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => NOW,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId),
    });
    svc.setConnection(connected("groq", { planAttested: true }));
    svc.registerManagedPool("groq", "server-fleet-1");

    const routes = svc.capacityRoutes().filter((r) => r.providerId === "groq" && r.modelId === "openai/gpt-oss-120b");
    // User pool + managed pool are separate physical domains — both projected.
    const userRoute = routes.find((r) => r.capacityPoolScope === "PER_USER_POOL");
    const managedRoute = routes.find((r) => r.capacityPoolScope === "SHARED_OWNER_POOL");
    expect(userRoute?.capacityPoolId).toBe("groq:user:localconn:groq");
    expect(userRoute?.supplyClass).toBe("USER_CONNECTED_FREE");
    expect(managedRoute?.capacityPoolId.startsWith("managed:groq:server-fleet-1")).toBe(true);
    expect(managedRoute?.supplyClass).toBe("PURE_MANAGED_FREE");
    expect(managedRoute?.capacityIdentity).toBe("managed:groq:server-fleet-1");

    // Managed supply on a per-user provider does not leak user-scope or admission proof.
    expect(managedRoute?.capacityScope).toBe("ORG");
    expect(managedRoute?.freeOnlyAdmissionProven).toBeUndefined();
  });
});

describe("FreeCloudService — billing-safety red team (R34 Mission P)", () => {
  function redService() {
    const fw = new ForgeZero();
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE" }));
    fw.register(freeRecord("openrouter", "openai/gpt-oss-120b:free"));
    const catalog = new InMemoryProviderCatalog();
    catalog.register(createMockProvider({ providerId: "groq" }));
    catalog.register(createMockProvider({ providerId: "openrouter" }));
    const svc = new FreeCloudService({
      firewall: fw,
      providerCatalog: catalog,
      registry: new NormalizedModelRegistry(),
      now: () => NOW,
      qualificationRunner: async (model) => receipt(model.providerId, model.modelId),
    });
    return { svc, fw };
  }

  it("BYOK leak: a user-connected key never lands on the managed/shared surface", () => {
    const { svc } = redService();
    svc.setConnection(connected("groq", { planAttested: true, ownerUserId: "alice" }));
    svc.setConnection(connected("openrouter", { credentialSource: "OAUTH", ownerUserId: "alice" }));

    // The server's managed surface (index.ts: capacityPoolScope !== PER_USER_POOL).
    const managed = svc.capacityRoutes().filter((r) => r.capacityPoolScope !== "PER_USER_POOL");
    expect(managed.every((r) => r.providerId !== "groq" && r.providerId !== "openrouter")).toBe(true);
    // And no managed pool row claims the user's credentials.
    expect(svc.capacityPools().filter((p) => p.scope !== "PER_USER_POOL")).toEqual([]);
    // Bob cannot see Alice's supply through any projection.
    expect(svc.routesForUser("bob")).toEqual([]);
    expect(svc.capacityIdentitiesFor("bob")).toEqual([]);
  });

  it("dev-key leak: an ENVIRONMENT credential classifies OWNER_DEV_FREE and is product-denied", () => {
    const { svc } = redService();
    svc.setConnection(connected("groq", { credentialSource: "ENVIRONMENT", planAttested: true }));
    const routes = svc.capacityRoutes().filter((r) => r.providerId === "groq");
    expect(routes.every((r) => r.supplyClass === "OWNER_DEV_FREE")).toBe(true);
    expect(routes.every((r) => r.capacityPoolId.startsWith("owner:"))).toBe(true);
    // The owner/dev pool may appear on the managed surface for observability but the policy
    // gate refuses it — developer credentials never serve product traffic. (UNHEALTHY gates
    // first while unqualified; once eligible the class gate still denies — assert both.)
    for (const r of routes) {
      expect(freeRouteExclusionReason(r)).toBe("UNHEALTHY");
      expect(freeRouteExclusionReason({ ...r, healthy: true })).toBe("OWNER_DEV_FREE_NOT_PRODUCT_FREE");
    }
  });

  it("a provider 402 (paid plan required) marks the route UNAVAILABLE and un-healthy", () => {
    const { svc } = redService();
    svc.setConnection(connected("groq", { planAttested: true }));
    svc.onProviderResponse({ providerId: "groq", modelId: "openai/gpt-oss-120b", status: 402, headers: [], observedAt: NOW.getTime() });
    const route = svc.capacityRoutes().find((r) => r.providerId === "groq");
    expect(route?.healthy).toBe(false);
    expect(freeRouteExclusionReason(route!)).toBe("UNHEALTHY");
  });

  it(":free-suffix loss — a route re-verified as non-free loses explicitZeroPrice and is denied", () => {
    const { svc, fw } = redService();
    // An ACCOUNT_DEPENDENT provider WITHOUT a free-plan attestation is where the price gate
    // matters: freeOnlyAdmissionProven stays false, so verifiedFree is the only thing keeping
    // the route inside zero-cash.
    svc.setConnection(connected("groq", { planAttested: false }));
    const before = svc.capacityRoutes().find((r) => r.providerId === "groq");
    expect(before?.explicitZeroPrice).toBe(true);
    expect(before?.freeOnlyAdmissionProven).toBe(false);
    expect(freeRouteExclusionReason({ ...before!, healthy: true })).toBe("USER_CONNECTED_FREE_ONLY_GUARD_NOT_PROVEN");

    // Catalog refresh observed the model renamed off the free surface — re-register without
    // verification. explicitZeroPrice flips false and the price gate denies outright.
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE", freeStatus: "unknown" as FreeModelRecord["freeStatus"] }));
    const after = svc.capacityRoutes().find((r) => r.providerId === "groq");
    expect(after?.explicitZeroPrice).toBe(false);
    expect(freeRouteExclusionReason(after!)).toBe("UNHEALTHY");
    expect(freeRouteExclusionReason({ ...after!, healthy: true })).toBe("PRICE_NOT_EXPLICITLY_ZERO");
  });

  it("a PAID_API provider's user key is PER_USER_POOL only — never on the managed surface", () => {
    const { svc, fw } = redService();
    fw.register(freeRecord("anthropic", "claude-sonnet-4", { freeStatus: "verified_free" }));
    svc.setConnection(connected("anthropic", { credentialSource: "SECURE_STORAGE", planAttested: true, ownerUserId: "alice" }));
    // A user's own paid-capable key is USER_CONNECTED_FREE — the BYOK path is per-user by
    // construction. What must be proven: it can never masquerade as managed supply.
    const routes = svc.capacityRoutes().filter((r) => r.providerId === "anthropic");
    expect(routes.every((r) => r.supplyClass === "USER_CONNECTED_FREE")).toBe(true);
    expect(routes.every((r) => r.capacityPoolScope === "PER_USER_POOL")).toBe(true);
    expect(svc.capacityRoutes().filter((r) => r.capacityPoolScope !== "PER_USER_POOL").some((r) => r.providerId === "anthropic")).toBe(false);
    expect(svc.routesForUser("bob").some((r) => r.providerId === "anthropic")).toBe(false);
  });

  it("oversubscribe: concurrent demands past a model-domain window deny honestly", () => {
    const { svc } = redService();
    svc.setConnection(connected("groq", { credentialSource: "FDS_GATEWAY" }));
    svc.quota.record("groq", "openai/gpt-oss-120b", { remainingRequests: 1000, limitRequests: 1000, remainingTokens: 8000, limitTokens: 8000, observedAt: NOW.toISOString() });
    const routes = svc.capacityRoutes().filter((r) => r.providerId === "groq");
    const pools = svc.capacityPools();
    const ledger = new CapacityReservationLedger({
      routes: routes.map((r) => ({ ...r, roles: ["CODER"], enabled: true, healthy: true, lifecycle: "APPROVED" as const })),
      pools,
      firstRunReserveRequests: 0,
      firstRunReserveTokens: 0,
      maxActiveReservationsPerUser: 10,
      now: () => NOW.getTime(),
    });
    const base = { userId: "u1", role: "CODER", taskKind: "interactive_turn", requests: 1, outputTokens: 0, isNewUser: false, priority: "normal" as const, createdAt: NOW.toISOString(), leaseUntil: new Date(NOW.getTime() + 60_000).toISOString() };
    const first = ledger.reserve({ ...base, reservationId: "r1", routeIds: routes.map((r) => r.routeId), inputTokens: 5000 });
    const second = ledger.reserve({ ...base, reservationId: "r2", routeIds: routes.map((r) => r.routeId), inputTokens: 5000 });
    expect(first.admitted).toBe(true);
    // 8k TPM − 5k active = 3k remaining < 5k demanded → honest denial, never oversubscribed.
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe("CAPACITY_EXHAUSTED");
  });

  it("policy-state preservation: quarantine survives route-table refresh and catalog churn", () => {
    const { svc, fw } = redService();
    svc.setConnection(connected("groq", { credentialSource: "FDS_GATEWAY" }));
    svc.quota.record("groq", "openai/gpt-oss-120b", { remainingRequests: 1000, limitRequests: 1000, observedAt: NOW.toISOString() });
    const poolId = svc.capacityRoutes().find((r) => r.providerId === "groq")!.capacityPoolId;
    svc.quarantinePool(poolId, "operator kill switch");

    // A catalog refresh re-registers the model — the route row is rebuilt from scratch, but
    // the quarantine lives on the pool id, not the row: the rebuilt route is still denied.
    fw.register(freeRecord("groq", "openai/gpt-oss-120b", { accessClass: "FREE_ALLOWANCE", displayName: "gpt-oss-120b refreshed" }));
    const after = svc.capacityRoutes().find((r) => r.providerId === "groq");
    expect(after?.enabled).toBe(false);
    expect(after?.lifecycle).toBe("QUARANTINED");
    expect(freeRouteExclusionReason(after!)).toBe("DISABLED");
  });
});
