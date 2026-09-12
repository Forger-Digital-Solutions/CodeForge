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
