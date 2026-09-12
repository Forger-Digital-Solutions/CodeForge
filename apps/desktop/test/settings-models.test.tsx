import { describe, expect, it } from "vitest";
import { ModelsRoutingSection } from "../src/renderer/settings/sections/ModelsRoutingSection.js";
import { GemsSection } from "../src/renderer/settings/sections/GemsSection.js";
import { buildModelSections } from "../src/renderer/model-sections.js";
import { renderSection, createSettingsContext } from "./settings-test-harness.js";
import type { ApiModel } from "../src/renderer/model-sections.js";
import type { ModelSelectorItem } from "@codeforge/ui";

const FIXTURE_MODELS: ApiModel[] = [
  {
    id: "auto",
    providerId: "codeforge",
    displayName: "ForgeAuto/Free",
    tier: "free",
    freeStatus: "verified_free",
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false },
  },
  {
    id: "nemotron",
    providerId: "codeforge-cloud",
    displayName: "Nemotron Super",
    tier: "free",
    freeStatus: "verified_free",
    accessClass: "FREE_NATIVE",
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false },
  },
  {
    id: "glm-flash",
    providerId: "zai",
    displayName: "GLM Flash",
    tier: "free",
    freeStatus: "verified_free",
    accessClass: "FREE_NATIVE",
    costProfile: { inputCostPerMillion: 0, outputCostPerMillion: 0, isFree: true, paidFallbackPossible: false },
  },
  {
    id: "gems-topaz",
    providerId: "codeforge",
    displayName: "Topaz",
    tier: "gems_paid",
    freeStatus: "paid",
    costProfile: { inputCostPerMillion: 1, outputCostPerMillion: 3, isFree: false, paidFallbackPossible: false },
  },
];

/** Exactly what the real workspace shell passes to settings: the canonical grouping over /api/models. */
function canonicalContext(overrides: Parameters<typeof createSettingsContext>[0] = {}) {
  const items: ModelSelectorItem[] = [
    { id: "auto", displayName: "ForgeAuto/Free", tier: "free", description: "Automatic free routing" },
    ...FIXTURE_MODELS.filter((m) => m.id !== "auto").map((m) => ({
      id: m.id,
      displayName: m.displayName,
      tier: m.tier === "gems_paid" ? ("gems_paid" as const) : ("free" as const),
      description: "Free",
    })),
  ];
  return createSettingsContext({
    apiModels: FIXTURE_MODELS,
    modelSections: buildModelSections(FIXTURE_MODELS, items),
    ...overrides,
  });
}

describe("Models & Routing page", () => {
  it("reuses the canonical catalog sections and reports truthful catalog counts", () => {
    const markup = renderSection(<ModelsRoutingSection />, canonicalContext());
    expect(markup).toContain("ForgeAuto/Free");
    expect(markup).toContain("2 free models listed · 3 verified-free routes in the catalog · 1 GEMS");
    expect(markup).toContain("Healthy");
  });

  it("marks ForgeZero enforcement as always-on and links privacy routing elsewhere", () => {
    const markup = renderSection(<ModelsRoutingSection />, canonicalContext());
    expect(markup).toContain("Zero-billing enforcement");
    expect(markup).toContain("Cannot be disabled");
    expect(markup).toContain("Privacy routing mode");
  });

  it("surfaces the manual catalog refresh affordance", () => {
    const markup = renderSection(<ModelsRoutingSection />, canonicalContext());
    expect(markup).toContain("Refresh catalog");
    expect(markup).toContain("8-Bit free catalog");
  });

  it("flags degraded routing when a connected provider health check fails", () => {
    const markup = renderSection(
      <ModelsRoutingSection />,
      canonicalContext({ providerStatus: { zai: { status: "error", error: "401 unauthorized" } } }),
    );
    expect(markup).toContain("Degraded");
  });
});

describe("GEMS page", () => {
  it("lists the four GEMS with authoritative specializations and truthful Coming soon state", () => {
    const context = createSettingsContext({ apiModels: FIXTURE_MODELS });
    const markup = renderSection(<GemsSection />, context);
    for (const [name, specialization] of [
      ["Topaz", "Fast Autonomous"],
      ["Sapphire", "Deep Reasoning"],
      ["Peridot", "Specialized Toolchain"],
      ["Garnet", "Ultra Architecture"],
    ] as const) {
      expect(markup).toContain(name);
      expect(markup).toContain(specialization);
    }
    expect(markup.match(/Coming soon/g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup).toContain("require a CodeForge entitlement");
  });

  it("never presents GEMS as free routing", () => {
    const markup = renderSection(<GemsSection />, createSettingsContext({ apiModels: [] }));
    expect(markup).toContain("never silently substitutes a paid route");
  });
});
