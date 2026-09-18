import { describe, expect, it } from "vitest";
import { ProvidersSection } from "../src/renderer/settings/sections/ProvidersSection.js";
import { ModelsRoutingSection } from "../src/renderer/settings/sections/ModelsRoutingSection.js";
import { AdvancedSection } from "../src/renderer/settings/sections/AdvancedSection.js";
import { AboutSection } from "../src/renderer/settings/sections/AboutSection.js";
import { renderSection, createSettingsContext } from "./settings-test-harness.js";
import type { EnvironmentCredentialView, ProviderConnectionView } from "../src/provider-connection-types.js";
import type { FreeCloudView } from "../src/renderer/model-sections.js";

const GROQ_SECRET = "gsk_supersecret_value_0123456789abcdef";

function connection(overrides: Partial<ProviderConnectionView>): ProviderConnectionView {
  return {
    providerId: "groq",
    displayName: "Groq",
    kind: "direct",
    implemented: true,
    recommendedForFreeDefault: true,
    authClasses: ["ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"],
    fields: [{ id: "apiKey", label: "API key", secret: true, optional: false, environmentAliases: ["GROQ_API_KEY"] }],
    freeAccess: { class: "FREE_DAILY_ALLOCATION", quota: "Free plan: 30 RPM / 1K RPD", spillover: "ACCOUNT_DEPENDENT", planDetection: "attestation", evidence: { source: "docs", checkedAt: "2026-09-12" } },
    privacy: { class: "standard" },
    terms: { status: "CLEARED" },
    connected: false,
    credentialSource: "NONE",
    authState: "unknown",
    planAttested: false,
    planAttestationRequired: true,
    environment: null,
    freeRouteCount: 0,
    healthyRouteCount: 0,
    catalogCount: 0,
    paidOnly: false,
    zeroCashFreeAccess: true,
    sortRank: 4,
    ...overrides,
  };
}

const ENV_GROQ: EnvironmentCredentialView = {
  providerId: "groq",
  displayName: "Groq",
  complete: true,
  anyDetected: true,
  fields: [{ fieldId: "apiKey", label: "API key", secret: true, optional: false, variable: "GROQ_API_KEY", aliases: ["GROQ_API_KEY"], detected: true }],
  zeroCashFreeAccess: true,
  paidOnly: false,
  enabled: false,
  active: false,
  policyBlocked: false,
};

const ENV_OPENAI: EnvironmentCredentialView = {
  providerId: "openai",
  displayName: "OpenAI",
  complete: true,
  anyDetected: true,
  fields: [{ fieldId: "apiKey", label: "API key", secret: true, optional: false, variable: "OPENAI_API_KEY", aliases: ["OPENAI_API_KEY"], detected: true }],
  zeroCashFreeAccess: false,
  paidOnly: true,
  enabled: false,
  active: false,
  policyBlocked: true,
  policyBlockedReason: "Paid provider — not used by ForgeAuto/Free (enable BYOK routes to use it)",
};

const SUMMARY = {
  canonicalModels: 4,
  verifiedFreeModels: 3,
  verifiedFreeRoutes: 5,
  healthyFreeRoutes: 4,
  connectedProviders: 2,
  coolingDown: 1,
  primaryCodingModels: 2,
  paidRoutesExcluded: 3,
  sameModelMultiProviderModels: 1,
  qualifying: false,
  pendingQualification: 0,
  discovering: 0,
  generatedAt: "2026-09-12T12:00:00.000Z",
};

describe("Provider Connections page", () => {
  it("is framed as optional expansion, not a prerequisite", () => {
    const markup = renderSection(<ProvidersSection connections={[]} environment={[]} summary={SUMMARY} />, createSettingsContext());
    expect(markup).toContain("Optional providers expand CodeForge");
    expect(markup).toContain("without any provider configuration");
    expect(markup).toContain("Search providers");
  });

  it("shows detected environment credentials by NAME with a toggle and never the value", () => {
    const markup = renderSection(
      <ProvidersSection connections={[connection({ environment: ENV_GROQ, connectOffer: { authClass: "ENVIRONMENT_CREDENTIAL", label: "Use existing GROQ_API_KEY", environmentVariable: "GROQ_API_KEY" }, sortRank: 1 })]} environment={[ENV_GROQ, ENV_OPENAI]} summary={SUMMARY} />,
      createSettingsContext(),
    );
    expect(markup).toContain("Detected environment credentials (2)");
    expect(markup).toContain("GROQ_API_KEY");
    expect(markup).toContain("Detected in environment");
    expect(markup).toContain('aria-label="Use Groq environment credential"');
    expect(markup).toContain("OPENAI_API_KEY");
    expect(markup).toContain("Paid provider · Not used by ForgeAuto/Free");
    expect(markup).toContain("Enable for BYOK");
    expect(markup).toContain("Use Environment Credential");
    expect(markup).not.toContain(GROQ_SECRET);
    expect(markup).not.toContain("gsk_");
  });

  it("renders connection cards with truthful state, credential source and counts", () => {
    const markup = renderSection(
      <ProvidersSection
        connections={[
          connection({ providerId: "openrouter", displayName: "OpenRouter", connected: true, credentialSource: "OAUTH", authState: "ok", freeRouteCount: 18, healthyRouteCount: 12, planAttestationRequired: false, authClasses: ["OAUTH_PKCE", "ENVIRONMENT_CREDENTIAL", "ASSISTED_KEY"], freeAccess: { class: "FREE_API", spillover: "NONE", planDetection: "not_required", evidence: { source: "docs", checkedAt: "2026-09-12" } }, sortRank: 0 }),
          connection({ connected: true, credentialSource: "ENVIRONMENT", environmentVariable: "GROQ_API_KEY", authState: "ok", freeRouteCount: 3, healthyRouteCount: 3, sortRank: 0 }),
          connection({ providerId: "sambanova", displayName: "SambaNova", connected: false, connectOffer: { authClass: "ASSISTED_KEY", label: "SambaNova · provider key required" } }),
        ]}
        environment={[]}
        summary={SUMMARY}
      />,
      createSettingsContext(),
    );
    expect(markup).toContain("Your providers (2 connected)");
    expect(markup).toContain("Credential source: OAuth");
    expect(markup).toContain("18 free routes · 12 ForgeAuto-eligible");
    expect(markup).toContain("Credential source: Environment · GROQ_API_KEY");
    expect(markup).toContain("account is on the free plan");
    expect(markup).toContain("SambaNova · provider key required");
    expect(markup).toContain("3 verified free models · 4 healthy routes");
  });

  it("offers the ZCode-style Add Provider flow with masked fields and no pre-filled secret", () => {
    const markup = renderSection(<ProvidersSection connections={[connection({})]} environment={[]} summary={SUMMARY} />, createSettingsContext());
    expect(markup).toContain("Add provider");
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Validate");
    expect(markup).not.toContain("sk-");
    expect(markup).not.toMatch(/value="[^"]*gsk_/);
  });

  it("shows the Gemini free-tier disclosure and terms link when policy metadata requires consent", () => {
    const markup = renderSection(<ProvidersSection connections={[connection({ providerId: "google", displayName: "Google Gemini", policyMetadata: { commercial_packaging_eligible: true, user_policy_acceptance_required: true, region_restrictions: ["EEA", "UK", "CH"], data_use_class: "TRAINING_POSSIBLE", confidential_data_eligible: false, free_or_paid_class: "UNPAID_ALLOWANCE", policy_revision: "gemini-api-unpaid-data-use/2026-03-23", official_terms_url: "https://ai.google.dev/gemini-api/terms" }, geminiPolicyAccepted: false, geminiPolicyBlockedReason: "GEMINI_REGION_UNKNOWN" })]} environment={[]} summary={SUMMARY} />, createSettingsContext());
    expect(markup).toContain("Gemini Free Tier is policy-gated");
    expect(markup).toContain("I understand and accept the Gemini API Free Tier data-use notice.");
    expect(markup).toContain("https://ai.google.dev/gemini-api/terms");
  });

  it("does not represent Cloudflare Paid as unlimited free capacity when usage is unknown", () => {
    const markup = renderSection(<ProvidersSection connections={[connection({ providerId: "cloudflare-workers-ai", displayName: "Cloudflare Workers AI", freeAccess: { class: "FREE_DAILY_ALLOCATION", quota: "Workers Free: 10,000 Neurons/day", spillover: "ACCOUNT_DEPENDENT", planDetection: "attestation", allowanceScope: "allowlist", allowanceModels: [], paidPlanModels: [] }, cloudflareBudgetStatus: "unknown" })]} environment={[]} summary={SUMMARY} />, createSettingsContext());
    expect(markup).toContain("usage unknown — route blocked");
    expect(markup).toContain("8,000 Neurons/day safe ceiling");
    expect(markup).toContain("paid overflow disabled");
  });
});

describe("Models & Routing page — 8-Bit registry", () => {
  const registry: FreeCloudView = {
    generatedAt: "2026-09-12T12:00:00.000Z",
    summary: SUMMARY,
    providers: [],
    models: [
      {
        canonicalId: "openai/gpt-oss-120b",
        displayName: "GPT-OSS 120B",
        family: "gpt-oss",
        lab: "openai",
        readiness: "FREE_AVAILABLE",
        freeRouteCount: 2,
        healthyFreeRouteCount: 2,
        connectedFreeRouteCount: 2,
        capabilities: { toolCalling: true, structuredOutput: true, vision: false, reasoning: false },
        contextWindow: 131072,
        qualificationState: "QUALIFIED",
        roles: ["PRIMARY_CODING_AGENT"],
        recommendedRole: "PRIMARY_CODING_AGENT",
        category: "Recommended",
        forgeAutoEligible: true,
        freeBadge: "Free · 2 routes",
        routes: [
          { routeId: "groq::openai/gpt-oss-120b", canonicalModelId: "openai/gpt-oss-120b", providerId: "groq", providerDisplayName: "Groq", providerModelId: "openai/gpt-oss-120b", displayName: "GPT-OSS 120B", freeAccessClass: "FREE_DAILY_ALLOCATION", authClass: "ENVIRONMENT_CREDENTIAL", credentialSource: "ENVIRONMENT", connected: true, verifiedFree: true, toolSupport: true, structuredOutput: true, vision: false, termsStatus: "CLEARED", health: "HEALTHY", qualificationState: "QUALIFIED", roles: ["PRIMARY_CODING_AGENT"], admission: { state: "FORGEAUTO_ELIGIBLE", passed: [] }, forgeAutoEligible: true, executable: true, deprecated: false },
          { routeId: "openrouter::openai/gpt-oss-120b:free", canonicalModelId: "openai/gpt-oss-120b", providerId: "openrouter", providerDisplayName: "OpenRouter", providerModelId: "openai/gpt-oss-120b:free", displayName: "GPT-OSS 120B", freeAccessClass: "FREE_API", authClass: "OAUTH_PKCE", credentialSource: "OAUTH", connected: true, verifiedFree: true, toolSupport: true, structuredOutput: true, vision: false, termsStatus: "CLEARED", health: "COOLDOWN", cooldownUntil: Date.now() + 18 * 60000, qualificationState: "QUALIFIED", roles: ["PRIMARY_CODING_AGENT"], admission: { state: "CODEFORGE_QUALIFIED", passed: [], failedGate: "HEALTHY", reason: "Route is cooling down after provider failures" }, forgeAutoEligible: false, executable: true, deprecated: false },
        ],
      },
    ],
  };

  it("reports real registry counts and lists canonical models once with truthful badges", () => {
    const markup = renderSection(<ModelsRoutingSection registry={registry} summary={SUMMARY} />, createSettingsContext());
    expect(markup).toContain("3 verified free models · 5 verified routes · 4 healthy");
    expect(markup).toContain("4 canonical models across 2 connected providers");
    expect(markup).toContain("1 served by multiple providers");
    expect(markup).toContain("GPT-OSS 120B");
    expect(markup).toContain("Free · 2 routes");
    expect((markup.match(/GPT-OSS 120B/g) ?? []).length).toBe(1);
    expect(markup).toContain("Route diagnostics");
  });
});

describe("Advanced page", () => {
  it("reports catalog diagnostics from the real catalog", () => {
    const markup = renderSection(<AdvancedSection />, createSettingsContext());
    expect(markup).toContain("Catalog diagnostics");
    expect(markup).toContain("Reset application preferences");
    expect(markup).toContain("Open data folder");
  });

  it("defines what the reset operation resets — and what it keeps", () => {
    const markup = renderSection(<AdvancedSection />, createSettingsContext());
    expect(markup).toContain("Resets Settings preferences");
    expect(markup).toContain("Provider credentials, close behavior, and workspace history are kept");
    // Two-step confirmation: the destructive action itself is not present on first render.
    expect(markup).not.toMatch(/>Reset preferences</);
  });
});

describe("About page", () => {
  it("shows real version, channel, and runtime facts", () => {
    const markup = renderSection(<AboutSection />, createSettingsContext());
    expect(markup).toContain("0.4.0");
    expect(markup).toContain("development");
    expect(markup).toContain("33.4.11");
  });
});
